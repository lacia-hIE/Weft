import type { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import {
  SessionPersistence, SessionPersistenceRevision,
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
  SessionOwnershipLostError, SessionPersistenceNotFoundError, SessionReadOnlyError,
  assertContiguous, assertStoredId, assertVersion, materializeAppendBatch,
  materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions,
  type SessionPersistenceOpenOptions, type SessionPersistenceStatOptions,
  type SessionPersistenceListOptions,
} from '@deepseek-ai/dsh-session-persistence';

type HeaderRow = {
  id: string;
  header_json: string;
  inherited_count: number;
  event_count: number;
  writer: string | null;
};

/** Called once by the owning DO constructor, never by an individual Context. */
export function initializeSessionStorage(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)');
    const version = storage.sql.exec<{ version: number }>('SELECT version FROM weft_schema WHERE singleton = 1').toArray()[0]?.version;
    if (version !== undefined && version !== 1) throw new Error(`Unsupported Weft storage schema ${version}`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS harness_sessions (
      id TEXT PRIMARY KEY, header_json TEXT NOT NULL, inherited_count INTEGER NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0, writer TEXT
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS harness_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`);
    // DO reconstruction invalidates old in-memory handles. New handles get new
    // tokens; stale continuations cannot release or mutate a replacement writer.
    storage.sql.exec('UPDATE harness_sessions SET writer = NULL');
    storage.sql.exec('INSERT OR IGNORE INTO weft_schema (singleton, version) VALUES (1, 1)');
  });
}

/** Current-format Harness persistence backed by the owning DO's SQLite database. */
export class SqliteSessionPersistence extends SessionPersistence {
  private readonly handles = new Set<SqliteHandle>();
  private readonly writers = new Map<SessionId, SqliteHandle>();
  readonly storage: DurableObjectStorage;

  constructor(ctx: Context, config: { storage: DurableObjectStorage }) {
    super(ctx);
    this.storage = config.storage;
    ctx.on('session/event', (session, event) => { this.writers.get(session.id)?.persistLive(event); });
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush());
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'SQLite handle teardown failed');
    });
  }

  row(id: SessionId): HeaderRow | undefined {
    return this.storage.sql.exec<HeaderRow>('SELECT * FROM harness_sessions WHERE id = ?', id).toArray()[0];
  }

  header(row: HeaderRow): SessionHeader {
    const header: SessionHeader = materializeCreateHeader(JSON.parse(row.header_json));
    assertStoredId(SessionId(row.id), header);
    assertVersion(header);
    return header;
  }

  private track(row: HeaderRow, access: SessionAccess, token: string | undefined): SqliteHandle {
    const handle = new SqliteHandle(this, this.header(row), SessionLogOffset(row.inherited_count), access, token);
    this.handles.add(handle);
    if (access === 'write') this.writers.set(handle.id, handle);
    return handle;
  }

  release(handle: SqliteHandle): void {
    this.handles.delete(handle);
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
  }

  override async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    assertVersion(snapshot);
    const inherited = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if ((snapshot.isSeeded === true && options?.inheritedEventCount === undefined) || (snapshot.isSeeded !== true && inherited !== 0)) {
      throw new Error('Inherited event count does not match the seeded header');
    }
    const token = crypto.randomUUID();
    const row = this.storage.transactionSync(() => {
      if (this.row(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id);
      this.storage.sql.exec(
        'INSERT INTO harness_sessions (id, header_json, inherited_count, writer) VALUES (?, ?, ?, ?)',
        snapshot.id, JSON.stringify(snapshot), inherited, token,
      );
      return this.row(snapshot.id)!;
    });
    return this.track(row, 'write', token);
  }

  override async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const token = access === 'write' ? crypto.randomUUID() : undefined;
    const row = this.storage.transactionSync(() => {
      const found = this.row(id);
      if (!found) throw new SessionPersistenceNotFoundError(id);
      this.header(found);
      if (access === 'write') {
        if (found.writer !== null) throw new SessionAlreadyOwnedError(id);
        this.storage.sql.exec('UPDATE harness_sessions SET writer = ? WHERE id = ?', token!, id);
      }
      return found;
    });
    return this.track(row, access, token);
  }

  override async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flushOwned()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'SQLite durability barrier failed');
  }

  override async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    options?.signal?.throwIfAborted();
    const row = this.row(id);
    return row ? {
      header: this.header(row), eventCount: row.event_count,
      revision: SessionPersistenceRevision(`${id}:${row.event_count}`),
    } : undefined;
  }

  override async list(options?: SessionPersistenceListOptions) {
    options?.signal?.throwIfAborted();
    const rows = this.storage.sql.exec<HeaderRow>('SELECT * FROM harness_sessions ORDER BY id').toArray();
    return rows.map(row => ({
      header: this.header(row), eventCount: row.event_count,
      revision: SessionPersistenceRevision(`${row.id}:${row.event_count}`),
    }));
  }
}

class SqliteHandle implements SessionHandle {
  readonly id: SessionId;
  private closing: Promise<void> | undefined;
  private liveFailure: unknown;

  constructor(
    private readonly provider: SqliteSessionPersistence,
    readonly header: SessionHeader,
    readonly inheritedEventCount: SessionLogOffset,
    readonly access: SessionAccess,
    private readonly token: string | undefined,
  ) { this.id = header.id; }

  private assertOpen(operation: string): void {
    if (this.closing) throw new SessionHandleClosedError(this.id, operation);
  }

  private assertWriter(operation: string): HeaderRow {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation);
    const row = this.provider.row(this.id);
    if (!row || row.writer !== this.token) throw new SessionOwnershipLostError(this.id);
    return row;
  }

  private persist(events: readonly SessionEvent[]): void {
    this.assertOpen('append');
    if (this.liveFailure) throw this.liveFailure;
    const batch = validateStoredEvents(this.header, [...materializeAppendBatch(events)]);
    this.provider.storage.transactionSync(() => {
      const row = this.assertWriter('append');
      assertContiguous(this.id, batch, row.event_count);
      for (const event of batch) this.provider.storage.sql.exec(
        'INSERT INTO harness_events (session_id, seq, event_json) VALUES (?, ?, ?)',
        this.id, event.seq, JSON.stringify(event),
      );
      this.provider.storage.sql.exec('UPDATE harness_sessions SET event_count = event_count + ? WHERE id = ?', batch.length, this.id);
    });
  }

  /** Event delivery is synchronous; retain a write failure for the durability barrier. */
  persistLive(event: SessionEvent): void {
    try { this.persist([event]); } catch (error) { this.liveFailure ??= error; }
  }

  async read(offset = 0, length?: number, options?: { signal?: AbortSignal }) {
    this.assertOpen('read');
    options?.signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
      throw new RangeError('Read offset and length must be non-negative safe integers');
    }
    const rows = this.provider.storage.sql.exec<{ event_json: string }>(
      'SELECT event_json FROM harness_events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
      this.id, offset, length ?? -1,
    ).toArray();
    const events = validateStoredEvents(this.header, rows.map(row => JSON.parse(row.event_json)));
    assertContiguous(this.id, events, offset);
    const row = this.provider.row(this.id);
    if (!row || events.length !== Math.min(Math.max(row.event_count - offset, 0), length ?? Infinity)) {
      throw new Error('Stored event count does not match the event log');
    }
    return { events, eventState: 'shared-frozen' as const };
  }

  async append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    this.persist(events);
  }

  async flush(options?: { signal?: AbortSignal }): Promise<void> {
    this.assertOpen('flush');
    options?.signal?.throwIfAborted();
    this.assertWriter('flush');
    if (this.liveFailure) throw this.liveFailure;
    await this.provider.storage.sync();
  }

  flushOwned(): Promise<void> { return this.closing ?? this.flush(); }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      try {
        if (this.access === 'write') {
          this.assertWriter('close');
          if (this.liveFailure) throw this.liveFailure;
          await this.provider.storage.sync();
        }
      } finally {
        if (this.access === 'write') this.provider.storage.sql.exec(
          'UPDATE harness_sessions SET writer = NULL WHERE id = ? AND writer = ?', this.id, this.token!,
        );
        this.provider.release(this);
      }
    })();
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
