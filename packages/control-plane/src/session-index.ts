/**
 * The Session index of one environment, owned by its EnvironmentDO in the
 * object's own SQLite storage. Sessions belong to one environment and are only
 * read through it, so the index needs no shared database.
 */
export class DurableSessionIndex<T extends {id: string; updatedAt: string}> {
  private readonly records = new Map<string, T>();

  constructor(private readonly sql: SqlStorage) {
    // `sessions` held the index before it moved to D1 and back; its rows are not carried over.
    sql.exec('DROP TABLE IF EXISTS sessions');
    sql.exec('CREATE TABLE IF NOT EXISTS session_index (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
    for (const row of sql.exec<{document: string}>('SELECT document FROM session_index')) {
      const record = JSON.parse(row.document) as T;
      this.records.set(record.id, record);
    }
  }

  has(sessionId: string): boolean { return this.records.has(sessionId); }

  get(sessionId: string): T | undefined {
    const record = this.records.get(sessionId);
    return record === undefined ? undefined : structuredClone(record);
  }

  /** Records ordered by most recent activity, then id. */
  list(): T[] {
    return [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).map(record => structuredClone(record));
  }

  remove(sessionId:string):void {this.sql.exec('DELETE FROM session_index WHERE id=?',sessionId);this.records.delete(sessionId);}

  put(record: T): void {
    this.sql.exec('INSERT INTO session_index VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document', record.id, JSON.stringify(record));
    this.records.set(record.id, structuredClone(record));
  }
}
