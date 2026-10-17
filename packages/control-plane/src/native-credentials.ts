import { CredentialProvider, credentialRef, parseCredentialKey, type CredentialRef, type CredentialKey, type CredentialRecord, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';

const recordSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('api-key'), key: z.string().min(1).optional(), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional()}).strict(),
  z.object({kind: z.literal('grant'), payload: z.json()}).strict(),
]);
function checkedRecord(value: unknown): CredentialRecord {
  const record = recordSchema.parse(value);
  return record.kind === 'grant' ? record : {kind: 'api-key', ...(record.key === undefined ? {} : {key: record.key}), ...(record.env === undefined ? {} : {env: record.env})};
}

/** Native credential seam with environment-local SQLite and an explicit host fallback. */
export class DurableCredentials extends CredentialProvider {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(ctx: Context, private readonly storage: DurableObjectStorage,
    private readonly fallback: (ref: CredentialRef) => ResolvedCredential | undefined,
    private readonly changed: (event: string, subject: string) => void) {
    super(ctx);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_credential_refs (ref TEXT PRIMARY KEY, value TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_credential_records (key TEXT PRIMARY KEY, document TEXT NOT NULL)');
  }
  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    credentialRef(ref);
    const row = this.storage.sql.exec<{value: string}>('SELECT value FROM weft_credential_refs WHERE ref=?', ref).toArray()[0];
    return row ? {value: row.value, source: 'environment'} : this.fallback(ref);
  }
  override async describe(ref: CredentialRef) {
    const value = await this.resolve(ref);
    return {configured: value !== undefined, ...(value ? {source: value.source} : {}), writable: true};
  }
  override async set(ref: CredentialRef, value: string): Promise<void> {
    credentialRef(ref);
    if (!value.trim() || new TextEncoder().encode(value).byteLength > 16_384) throw new Error('Credential must be nonempty and at most 16 KiB');
    this.storage.sql.exec('INSERT INTO weft_credential_refs VALUES (?,?) ON CONFLICT(ref) DO UPDATE SET value=excluded.value', ref, value);
    await this.storage.sync();
    this.notifyUpdated(ref);
    this.changed('credentials/reference-updated', ref);
  }
  override async unset(ref: CredentialRef): Promise<void> {
    credentialRef(ref);
    this.storage.sql.exec('DELETE FROM weft_credential_refs WHERE ref=?', ref);
    await this.storage.sync();
    this.notifyUpdated(ref);
    this.changed('credentials/reference-updated', ref);
  }
  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    parseCredentialKey(key);
    const row = this.storage.sql.exec<{document: string}>('SELECT document FROM weft_credential_records WHERE key=?', key).toArray()[0];
    return row ? checkedRecord(JSON.parse(row.document)) : undefined;
  }
  override async describeRecord(key: CredentialKey) {
    const record = await this.readRecord(key);
    return {configured: record !== undefined, ...(record ? {kind: record.kind} : {}), writable: true};
  }
  override async listRecords() {
    return this.storage.sql.exec<{key: string; document: string}>('SELECT key,document FROM weft_credential_records ORDER BY key').toArray().map(row => ({key: parseCredentialKey(row.key), kind: recordSchema.parse(JSON.parse(row.document)).kind}));
  }
  private async exclusive<T>(key: CredentialKey, operation: () => Promise<T>): Promise<T> {
    parseCredentialKey(key);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.then(operation);
    const settled = pending.then(() => {}, () => {});
    this.locks.set(key, settled);
    try { return await pending; }
    finally { if (this.locks.get(key) === settled) this.locks.delete(key); }
  }
  override async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    return this.exclusive(key, async () => {
      const current = await this.readRecord(key), next = await mutate(current);
      if (next === undefined) return current;
      const checked = checkedRecord(next);
      this.storage.sql.exec('INSERT INTO weft_credential_records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document', key, JSON.stringify(checked));
      await this.storage.sync();
      this.notifyRecordUpdated(key);
      this.changed('credentials/record-updated', key);
      return checked;
    });
  }
  override async deleteRecord(key: CredentialKey): Promise<void> {
    await this.exclusive(key, async () => {
      this.storage.sql.exec('DELETE FROM weft_credential_records WHERE key=?', key);
      await this.storage.sync();
      this.notifyRecordUpdated(key);
      this.changed('credentials/record-updated', key);
    });
  }
}
