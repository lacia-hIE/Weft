import type {SessionListValue} from '@deepseek-ai/dsh-api-session-controller/types';
import upstream from '../../../upstream.lock.json';

/** Disposable summaries. Session logs and their original projection folds remain authoritative. */
export class DurableSessionSummaries {
  private readonly format = `native-summaries-1:${upstream.commit}`;
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS weft_session_summaries (root_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, format TEXT NOT NULL, active INTEGER NOT NULL, document TEXT NOT NULL) STRICT');
  }
  read(): Map<string, {active: boolean; items: SessionListValue['items']}> {
    return new Map(this.sql.exec<{root_id: string; active: number; document: string}>('SELECT root_id,active,document FROM weft_session_summaries WHERE format=?', this.format).toArray().map(row => [row.root_id, {active: row.active === 1, items: JSON.parse(row.document) as SessionListValue['items']}]));
  }
  remove(root: string): void {this.sql.exec('DELETE FROM weft_session_summaries WHERE root_id=?', root);}
  put(root: string, revision: number, items: SessionListValue['items']): boolean {
    return this.sql.exec('INSERT INTO weft_session_summaries VALUES (?,?,?,?,?) ON CONFLICT(root_id) DO UPDATE SET revision=excluded.revision,format=excluded.format,active=excluded.active,document=excluded.document WHERE format<>excluded.format OR revision<excluded.revision RETURNING root_id', root, revision, this.format, Number(items.some(row => row.running)), JSON.stringify(items)).toArray().length === 1;
  }
}
