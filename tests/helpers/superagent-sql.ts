import {DatabaseSync} from 'node:sqlite';
import type {SqlService, SqlValue} from '../../plugins/superagent/src/infra/sql.ts';

/** The `weftSql` contract over a Node SQLite database, for specs that run outside workerd. */
export function memorySql(path = ':memory:'): SqlService & {close(): void; db: DatabaseSync} {
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    db,
    close: () => db.close(),
    exec: (query, ...bindings) => {
      const statements = bindings.length ? [query] : query.split(/;\s*\n/).map(text => text.trim()).filter(Boolean);
      let rows: Record<string, SqlValue>[] = [];
      for (const statement of statements) {
        const prepared = db.prepare(statement);
        rows = prepared.columns().length ? prepared.all(...bindings as never[]) as Record<string, SqlValue>[] : (prepared.run(...bindings as never[]), []);
      }
      return rows;
    },
    transaction: work => {
      const name = `spec_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {const value = work(); db.exec(`RELEASE ${name}`); return value;}
      catch (error) {db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error;}
      finally {depth--;}
    },
  };
}
