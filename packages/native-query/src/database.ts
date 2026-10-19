import {searchSchema, searchSchemaVersion} from '../../../.generated/official-search-schema.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {weftSessionSearchDatabase: DurableSearchDatabase;}
}

const prefix = 'weft_query_';
function durableSql(sql: string): string {
  return sql.replace(/\btemp\.(live_sessions|live_docs)\b/g, '$1')
    .replace(/\b(search_state|persisted_sessions|persisted_docs|live_sessions|live_docs)\b/g, name => prefix + name)
    .replace(/CREATE TEMP TABLE/g, 'CREATE TABLE');
}

/** A borrowed SQLite handle; closing it never closes or resets canonical storage. */
export class DurableSearchDatabase {
  private opened = false;
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage) {}

  open(): this {
    this.assertOpen();
    if (this.opened) return this;
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS weft_query_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
      const version = sql.exec<{version: number}>('SELECT version FROM weft_query_schema WHERE id=1').toArray()[0]?.version;
      if (version !== undefined && version !== searchSchemaVersion) {
        // Drop FTS parents before their metadata tables; SQLite owns the shadows.
        for (const name of ['persisted_docs', 'live_docs', 'persisted_sessions', 'live_sessions', 'search_state']) sql.exec(`DROP TABLE IF EXISTS ${prefix}${name}`);
      }
      for (const statement of searchSchema) sql.exec(durableSql(statement));
      // TEMP schemas are unavailable in Durable Objects. These derived tables
      // emulate connection lifetime and must never survive a new query owner.
      sql.exec('DELETE FROM weft_query_live_docs');
      sql.exec('DELETE FROM weft_query_live_sessions');
      sql.exec('INSERT INTO weft_query_schema VALUES (1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version', searchSchemaVersion);
    });
    this.opened = true;
    return this;
  }

  prepare(query: string) {
    const sql = durableSql(query);
    const execute = (bindings: SqlStorageValue[]) => {this.assertOpen(); return this.storage.sql.exec(sql, ...bindings);};
    return {
      all: (...bindings: SqlStorageValue[]) => execute(bindings).toArray(),
      get: (...bindings: SqlStorageValue[]) => execute(bindings).toArray()[0],
      run: (...bindings: SqlStorageValue[]) => {
        const cursor = execute(bindings);
        // Fully consume results before a containing transaction can commit.
        cursor.toArray();
        return {changes: cursor.rowsWritten};
      },
    };
  }

  transactionSync<T>(operation: () => T): T {this.assertOpen(); return this.storage.transactionSync(operation);}
  close(): void {this.closed = true;}
  private assertOpen(): void {if (this.closed) throw new Error('Session search database handle is closed');}
}
