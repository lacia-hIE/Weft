import type {DocumentResult} from './converter.ts';

export interface DocumentCache {
  get(key: string): DocumentResult | undefined;
  put(key: string, value: DocumentResult): void;
}

/** This SQLite instance belongs to exactly one tenant/environment workspace. */
export class SQLiteDocumentCache implements DocumentCache {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS weft_document_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, accessed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  }
  get(key: string): DocumentResult | undefined {
    this.sql.exec('DELETE FROM weft_document_cache WHERE expires_at<=?', Date.now());
    const row = this.sql.exec<{value: string}>('SELECT value FROM weft_document_cache WHERE key=?', key).toArray()[0];
    if (!row) return undefined;
    this.sql.exec('UPDATE weft_document_cache SET accessed_at=? WHERE key=?', Date.now(), key);
    return JSON.parse(row.value) as DocumentResult;
  }
  put(key: string, value: DocumentResult): void {
    const text = JSON.stringify(value), now = Date.now();
    this.sql.exec('DELETE FROM weft_document_cache WHERE expires_at<=?', now);
    this.sql.exec('INSERT OR REPLACE INTO weft_document_cache VALUES (?,?,?,?,?)', key, text, new TextEncoder().encode(text).byteLength, now, now + 7 * 86400000);
    // A small bounded cache rather than an unbounded copy of source documents.
    while (true) {
      const usage = this.sql.exec<{n: number; bytes: number}>('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM weft_document_cache').one();
      if (usage.n <= 64 && usage.bytes <= 8 * 1024 * 1024) break;
      this.sql.exec('DELETE FROM weft_document_cache WHERE key=(SELECT key FROM weft_document_cache ORDER BY accessed_at,key LIMIT 1)');
    }
  }
}
