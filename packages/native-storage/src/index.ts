import type { Context } from '@deepseek-ai/cordis';
import Storage, { StorageError, UNIT_NAME_RE, storageBackendServiceKey, type KvFacet, type KvUnit, type KvUnitDescriptor, type StorageBackend } from '@deepseek-ai/dsh-storage';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';

export const DURABLE_STORAGE_BACKEND = 'durable-object';


// The original `storage-sqlite` layout, under a private prefix inside the owning Durable Object.
const UNITS = 'weft_kv_units', GLOBALS = 'weft_kv_unit_globals';
const physical = (unit: string, table: string): string => `weft_kv_u_${unit}_${table}`;

/** One KV unit in the original SQLite layout: a JSON row per record plus an optional global slot. */
class DurableKvUnit implements KvUnit {
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly descriptor: KvUnitDescriptor, private readonly onClose: () => void) {}

  async loadAll(): Promise<{tables: Record<string, Record<string, unknown>>; global: unknown}> {
    this.ensureOpen();
    const tables: Record<string, Record<string, unknown>> = {};
    for (const table of this.descriptor.tables) {
      // Null prototype: record keys are arbitrary strings, including '__proto__'.
      const records = Object.create(null) as Record<string, unknown>;
      for (const row of this.storage.sql.exec<{key: string; value: string}>(`SELECT key, value FROM "${physical(this.descriptor.name, table)}"`)) records[row.key] = this.parse(row.value, `table '${table}' key '${row.key}'`);
      tables[table] = records;
    }
    const row = this.descriptor.hasGlobal ? this.storage.sql.exec<{value: string}>(`SELECT value FROM ${GLOBALS} WHERE unit = ?`, this.descriptor.name).toArray()[0] : undefined;
    return {tables, global: row ? this.parse(row.value, 'global slot') : null};
  }
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.ensureOpen();
    this.storage.sql.exec(`INSERT INTO "${this.table(table)}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
  }
  async deleteRecord(table: string, key: string): Promise<void> {
    this.ensureOpen();
    this.storage.sql.exec(`DELETE FROM "${this.table(table)}" WHERE key = ?`, key);
  }
  async setGlobal(value: unknown): Promise<void> {
    this.ensureOpen();
    if (!this.descriptor.hasGlobal) throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`);
    this.storage.sql.exec(`INSERT INTO ${GLOBALS} (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value`, this.descriptor.name, JSON.stringify(value));
  }
  async close(): Promise<void> { if (!this.closed) {this.closed = true; this.onClose();} }

  private table(table: string): string {
    if (!this.descriptor.tables.includes(table)) throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`);
    return physical(this.descriptor.name, table);
  }
  private parse(text: string, slot: string): unknown {
    try { return JSON.parse(text); }
    catch (error) { throw new StorageError('malformed-medium', `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`, {cause: error}); }
  }
  private ensureOpen(): void { if (this.closed) throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`); }
}

/** A `StorageBackend` whose KV units are the original SQLite units, stored in this DO. */
export class DurableStorageBackend implements StorageBackend {
  readonly kv: KvFacet = {open: descriptor => this.open(descriptor)};
  private readonly units = new Map<string, DurableKvUnit>();
  private closed = false;

  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${UNITS} (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${GLOBALS} (unit TEXT PRIMARY KEY REFERENCES ${UNITS}(name), value TEXT NOT NULL) STRICT`);
  }

  private async open(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closed) throw new StorageError('closed', 'durable storage backend is closed');
    for (const name of [descriptor.name, ...descriptor.tables]) if (!UNIT_NAME_RE.test(name)) throw new Error(`kv name '${name}' violates ${UNIT_NAME_RE}`);
    if (this.units.has(descriptor.name)) throw new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`);
    const row = this.storage.sql.exec<{version: number}>(`SELECT version FROM ${UNITS} WHERE name = ?`, descriptor.name).toArray()[0];
    if (row === undefined) this.storage.sql.exec(`INSERT INTO ${UNITS} (name, version) VALUES (?, ?)`, descriptor.name, descriptor.version);
    else if (row.version !== descriptor.version) {
      throw new StorageError('version-mismatch', `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`);
    }
    for (const table of descriptor.tables) this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS "${physical(descriptor.name, table)}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
    const unit = new DurableKvUnit(this.storage, descriptor, () => {this.units.delete(descriptor.name);});
    this.units.set(descriptor.name, unit);
    return unit;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unit of [...this.units.values()]) await unit.close();
  }
}

/** Mount the original storage hub and domain layer over this DO's SQLite. */
export async function mountDurableStorage(ctx: Context, storage: DurableObjectStorage): Promise<void> {
  await ctx.plugin(Storage);
  await ctx.plugin({name: 'weft-durable-storage-backend', inject: ['storage'], apply: (scope: Context) => {
    const backend = new DurableStorageBackend(storage);
    scope.effect(() => {
      const dispose = scope.storage.backend.register(DURABLE_STORAGE_BACKEND, backend);
      return async () => {dispose(); await backend.close();};
    }, 'weft-durable-storage.registerBackend');
    scope.provide(storageBackendServiceKey(DURABLE_STORAGE_BACKEND), backend);
  }});
  await ctx.plugin(StorageDomain, {backend: DURABLE_STORAGE_BACKEND});
}
