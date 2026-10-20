import {type Context} from '@deepseek-ai/cordis';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
import {DurableSearchDatabase} from './database.ts';

/** Install the original full-text provider with the owning DO's SQLite port. */
/** Derived-table owners within one DO: each role rebuilds only its own prefix. */
export type QueryRole = 'query' | 'runtime' | 'reference';
export async function installDurableSessionQuery(ctx: Context, storage: DurableObjectStorage, role: QueryRole = 'query'): Promise<void> {
  ctx.provide('weftSessionSearchDatabase', new DurableSearchDatabase(storage, role));
  await ctx.plugin(SqliteSessionQueryEngine, {path: ':durable-object:', openAt: 'first-search'});
}
