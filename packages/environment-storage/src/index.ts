/**
 * Cloudflare persistence for one Harness environment. These adapters know
 * neither D1 nor tenant routing: their owner supplies its private DO storage.
 * Schemas, permissions, native events and Loader reconciliation stay in the
 * environment services that consume them.
 */

/** Preset publication and settings writes share one ordering boundary. */
export class ConfigWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface SettingsDocument { revision: number; user: Record<string, unknown> }
export interface SettingsTransaction {
  get(ns: string): SettingsDocument;
  update(ns: string, change: (current: SettingsDocument) => SettingsDocument): SettingsDocument;
}

/** Settings are read synchronously from the authoritative local database. */
export class DurableSettingsDocuments {
  constructor(private readonly storage: DurableObjectStorage, private readonly queue: ConfigWriteQueue) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_settings_documents (ns TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_configuration_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT');
    storage.sql.exec('INSERT OR IGNORE INTO weft_configuration_revision VALUES (1,0)');
  }

  get revision(): number { return this.storage.sql.exec<{revision: number}>('SELECT revision FROM weft_configuration_revision WHERE id=1').one().revision; }
  touch(): void { this.storage.sql.exec('UPDATE weft_configuration_revision SET revision=revision+1 WHERE id=1'); }

  get(ns: string): SettingsDocument {
    const row = this.storage.sql.exec<{revision: number; document: string}>('SELECT revision,document FROM weft_settings_documents WHERE ns=?', ns).toArray()[0];
    return row ? {revision: row.revision, user: JSON.parse(row.document) as Record<string, unknown>} : {revision: 0, user: {}};
  }

  update(ns: string, change: (current: SettingsDocument) => SettingsDocument): Promise<SettingsDocument> {
    return this.transaction(tx => tx.update(ns, change));
  }

  /** Includes document version stamps; effects and notifications belong after fulfillment. */
  transaction<T>(operation: (tx: SettingsTransaction) => T): Promise<T> {
    return this.queue.run(async () => this.storage.transactionSync(() => {
      let changed = false;
      const value = operation({get: ns => this.get(ns), update: (ns, change) => {
        const current = this.get(ns), revision = current.revision, before = JSON.stringify(current.user);
        const next = change(current), document = JSON.stringify(next.user);
        if (next.revision !== revision || document !== before) {
          this.storage.sql.exec('INSERT INTO weft_settings_documents VALUES (?,?,?) ON CONFLICT(ns) DO UPDATE SET revision=excluded.revision,document=excluded.document', ns, next.revision, document);
          changed = true;
        }
        return this.get(ns);
      }});
      if (changed) this.touch();
      return value;
    }));
  }
}

/** Append-only published presets; cold starts do not load their full history. */
export class DurableAgentRevisions<T extends {revision: number}> {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_agent_revisions (agent_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(agent_id,revision)) STRICT');
  }

  latest(agentId: string): T | undefined {
    const row = this.storage.sql.exec<{document: string}>('SELECT document FROM weft_agent_revisions WHERE agent_id=? ORDER BY revision DESC LIMIT 1', agentId).toArray()[0];
    return row ? JSON.parse(row.document) as T : undefined;
  }

  revision(agentId: string, revision: number): T | undefined {
    const row = this.storage.sql.exec<{document: string}>('SELECT document FROM weft_agent_revisions WHERE agent_id=? AND revision=?', agentId, revision).toArray()[0];
    return row ? JSON.parse(row.document) as T : undefined;
  }

  current(): T[] {
    return this.storage.sql.exec<{document: string}>('SELECT r.document FROM weft_agent_revisions r JOIN (SELECT agent_id,MAX(revision) AS revision FROM weft_agent_revisions GROUP BY agent_id) latest USING(agent_id,revision) ORDER BY agent_id').toArray().map(row => JSON.parse(row.document) as T);
  }

  get count(): number {
    return this.storage.sql.exec<{count: number}>('SELECT COUNT(DISTINCT agent_id) AS count FROM weft_agent_revisions').one().count;
  }

  publish(agentId: string, value: T): boolean {
    // rowsWritten also counts index writes; RETURNING observes actual insertion.
    return this.storage.sql.exec('INSERT INTO weft_agent_revisions VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING revision', agentId, value.revision, JSON.stringify(value)).toArray().length === 1;
  }
}

export type WorkspaceRow = { id: string; path: string; document: string };
export interface WorkspaceTransaction {
  state(): string;
  storeState(document: string): void;
  get(id: string): WorkspaceRow | undefined;
  count(): number;
  save(row: WorkspaceRow): void;
  delete(id: string): void;
}

/** Native workspace records commit atomically in their owning environment. */
export class DurableWorkspaceRegistry {
  constructor(private readonly storage: DurableObjectStorage, initialState: string) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_workspace_registry_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL) STRICT');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_workspace_registry (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, document TEXT NOT NULL) STRICT');
    storage.sql.exec('INSERT OR IGNORE INTO weft_workspace_registry_state VALUES (1,?)', initialState);
  }

  state(): string { return this.storage.sql.exec<{document: string}>('SELECT document FROM weft_workspace_registry_state WHERE id=1').one().document; }
  get(id: string): WorkspaceRow | undefined { return this.storage.sql.exec<WorkspaceRow>('SELECT id,path,document FROM weft_workspace_registry WHERE id=?', id).toArray()[0]; }
  get count(): number { return this.storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_workspace_registry').one().count; }

  async transaction<T>(operation: (tx: WorkspaceTransaction) => T): Promise<T> {
    return this.storage.transactionSync(() => operation({
      state: () => this.state(),
      storeState: document => { this.storage.sql.exec('UPDATE weft_workspace_registry_state SET document=? WHERE id=1', document); },
      get: id => this.get(id),
      count: () => this.count,
      save: row => { this.storage.sql.exec('INSERT INTO weft_workspace_registry VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,document=excluded.document', row.id, row.path, row.document); },
      delete: id => { this.storage.sql.exec('DELETE FROM weft_workspace_registry WHERE id=?', id); },
    }));
  }
}
