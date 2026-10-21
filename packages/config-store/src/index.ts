import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

/** The tenant and environment one configuration store serves. */
export interface ConfigScope { tenantId: string; environmentId: string }

/**
 * One environment's configuration writes, run one at a time. Stores that
 * validate against each other (preset publication and the default preset
 * setting) share it, so a check and the write it guards see one state.
 */
export class ConfigWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** One settings namespace's user layer and its revision. */
export interface SettingsDocument { revision: number; user: Record<string, unknown> }

/**
 * Settings documents of one environment, kept in D1 and read from a cache.
 * The environment's Durable Object is the only writer for its rows, so the
 * cache loaded at activation stays exact; each write is still conditional on
 * the revision it read, and writes are serialized.
 */
export class D1SettingsDocuments {
  private readonly rows = new Map<string, SettingsDocument>();
  private constructor(private readonly db: D1Database, private readonly scope: ConfigScope, private readonly queue: ConfigWriteQueue) {}

  /** Load the environment's settings rows; writes run on the environment's shared queue. */
  static async open(db: D1Database, scope: ConfigScope, queue: ConfigWriteQueue): Promise<D1SettingsDocuments> {
    const store = new D1SettingsDocuments(db, scope, queue);
    const {results} = await db.prepare('SELECT ns, revision, document FROM environment_settings WHERE tenant_id = ? AND environment_id = ?')
      .bind(scope.tenantId, scope.environmentId).all<{ns: string; revision: number; document: string}>();
    for (const row of results) store.rows.set(row.ns, {revision: row.revision, user: JSON.parse(row.document) as Record<string, unknown>});
    return store;
  }

  get(ns: string): SettingsDocument {
    const row = this.rows.get(ns);
    return row ? {revision: row.revision, user: structuredClone(row.user)} : {revision: 0, user: {}};
  }

  /**
   * Apply one change after every earlier write settles. `change` reads the
   * current document and returns the next one, or throws to reject the write.
   * @returns the committed document.
   */
  update(ns: string, change: (current: SettingsDocument) => SettingsDocument): Promise<SettingsDocument> {
    return this.queue.run(async () => {
      const current = this.get(ns);
      const next = change(current);
      if (next.revision === current.revision && JSON.stringify(next.user) === JSON.stringify(current.user)) return current;
      const document = JSON.stringify(next.user);
      const result = current.revision === 0 && !this.rows.has(ns)
        ? await this.db.prepare('INSERT INTO environment_settings (tenant_id, environment_id, ns, revision, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .bind(this.scope.tenantId, this.scope.environmentId, ns, next.revision, document).run()
        : await this.db.prepare('UPDATE environment_settings SET revision = ?, document = ? WHERE tenant_id = ? AND environment_id = ? AND ns = ? AND revision = ?')
          .bind(next.revision, document, this.scope.tenantId, this.scope.environmentId, ns, current.revision).run();
      if (result.meta.changes !== 1) throw new RemoteError('settings/conflict', 'Configuration changed since it was read', {ns, expected: current.revision, actual: current.revision});
      this.rows.set(ns, {revision: next.revision, user: structuredClone(next.user)});
      return this.get(ns);
    });
  }
}

/**
 * Published Agent composition revisions of one environment, kept in D1 and
 * read from a cache. Revisions are append-only; a duplicate (id, revision)
 * insert is a publication conflict.
 */
export class D1AgentRevisions<T extends {revision: number}> {
  private readonly revisions = new Map<string, Map<number, T>>();
  private constructor(private readonly db: D1Database, private readonly scope: ConfigScope) {}

  static async open<T extends {revision: number}>(db: D1Database, scope: ConfigScope): Promise<D1AgentRevisions<T>> {
    const store = new D1AgentRevisions<T>(db, scope);
    const {results} = await db.prepare('SELECT agent_id, revision, document FROM agent_revisions WHERE tenant_id = ? AND environment_id = ?')
      .bind(scope.tenantId, scope.environmentId).all<{agent_id: string; revision: number; document: string}>();
    for (const row of results) store.remember(row.agent_id, JSON.parse(row.document) as T);
    return store;
  }

  private remember(agentId: string, value: T): void {
    let rows = this.revisions.get(agentId);
    if (!rows) this.revisions.set(agentId, rows = new Map());
    rows.set(value.revision, value);
  }

  /** The newest revision of an Agent. */
  latest(agentId: string): T | undefined {
    const rows = this.revisions.get(agentId);
    if (!rows?.size) return undefined;
    return structuredClone(rows.get(Math.max(...rows.keys())));
  }

  revision(agentId: string, revision: number): T | undefined {
    const value = this.revisions.get(agentId)?.get(revision);
    return value === undefined ? undefined : structuredClone(value);
  }

  /** The newest revision of every Agent, ordered by id. */
  current(): T[] {
    return [...this.revisions.keys()].sort().map(agentId => this.latest(agentId)!).filter(Boolean);
  }

  get count(): number { return this.revisions.size; }

  /** Append one revision; false when that (id, revision) was already published. */
  async publish(agentId: string, value: T): Promise<boolean> {
    if (this.revisions.get(agentId)?.has(value.revision)) return false;
    const result = await this.db.prepare('INSERT INTO agent_revisions (tenant_id, environment_id, agent_id, revision, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(this.scope.tenantId, this.scope.environmentId, agentId, value.revision, JSON.stringify(value)).run();
    if (result.meta.changes !== 1) return false;
    this.remember(agentId, structuredClone(value));
    return true;
  }
}

/** One Workspace row: its id, canonical path and JSON document. */
export interface WorkspaceRow { id: string; path: string; document: string }

/** The writes one registry transaction may make, applied to a private copy. */
export interface WorkspaceTransaction {
  state(): string;
  storeState(document: string): void;
  get(id: string): WorkspaceRow | undefined;
  count(): number;
  save(row: WorkspaceRow): void;
  delete(id: string): void;
}

/**
 * The Workspace registry of one environment, kept in D1 and read from a cache.
 * A transaction edits a copy; its changed rows commit in one D1 batch and the
 * copy replaces the cache only after the batch succeeds.
 */
export class D1WorkspaceRegistry {
  private stateDocument: string;
  private rows: Map<string, WorkspaceRow>;
  private constructor(private readonly db: D1Database, private readonly scope: ConfigScope, state: string, rows: Map<string, WorkspaceRow>) {
    this.stateDocument = state;
    this.rows = rows;
  }

  static async open(db: D1Database, scope: ConfigScope, initialState: string): Promise<D1WorkspaceRegistry> {
    await db.prepare('INSERT INTO workspace_state (tenant_id, environment_id, document) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(scope.tenantId, scope.environmentId, initialState).run();
    const [state, rows] = await db.batch([
      db.prepare('SELECT document FROM workspace_state WHERE tenant_id = ? AND environment_id = ?').bind(scope.tenantId, scope.environmentId),
      db.prepare('SELECT workspace_id AS id, path, document FROM workspaces WHERE tenant_id = ? AND environment_id = ?').bind(scope.tenantId, scope.environmentId),
    ]);
    const document = (state!.results[0] as {document: string}).document;
    return new D1WorkspaceRegistry(db, scope, document, new Map((rows!.results as WorkspaceRow[]).map(row => [row.id, row])));
  }

  state(): string { return this.stateDocument; }
  get(id: string): WorkspaceRow | undefined { return this.rows.get(id); }
  get count(): number { return this.rows.size; }

  async transaction<T>(operation: (tx: WorkspaceTransaction) => T): Promise<T> {
    let state = this.stateDocument;
    const rows = new Map(this.rows);
    const result = operation({
      state: () => state,
      storeState: document => { state = document; },
      get: id => rows.get(id),
      count: () => rows.size,
      save: row => {
        for (const other of rows.values()) if (other.id !== row.id && other.path === row.path) throw new Error('Workspace path is already registered');
        rows.set(row.id, row);
      },
      delete: id => { rows.delete(id); },
    });
    const {tenantId, environmentId} = this.scope;
    const statements: D1PreparedStatement[] = [];
    if (state !== this.stateDocument) statements.push(this.db.prepare('UPDATE workspace_state SET document = ? WHERE tenant_id = ? AND environment_id = ?').bind(state, tenantId, environmentId));
    for (const id of this.rows.keys()) if (!rows.has(id)) statements.push(this.db.prepare('DELETE FROM workspaces WHERE tenant_id = ? AND environment_id = ? AND workspace_id = ?').bind(tenantId, environmentId, id));
    for (const row of rows.values()) {
      const previous = this.rows.get(row.id);
      if (previous && previous.path === row.path && previous.document === row.document) continue;
      statements.push(this.db.prepare('INSERT INTO workspaces (tenant_id, environment_id, workspace_id, path, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, environment_id, workspace_id) DO UPDATE SET path = excluded.path, document = excluded.document')
        .bind(tenantId, environmentId, row.id, row.path, row.document));
    }
    if (statements.length) await this.db.batch(statements);
    this.stateDocument = state;
    this.rows = rows;
    return result;
  }
}
