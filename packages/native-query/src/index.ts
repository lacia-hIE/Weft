import {type Context} from '@deepseek-ai/cordis';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
import {DurableSearchDatabase} from './database.ts';

/** Install the original full-text provider with the owning DO's SQLite port. */
export async function installDurableSessionQuery(ctx: Context, storage: DurableObjectStorage): Promise<void> {
  ctx.provide('weftSessionSearchDatabase', new DurableSearchDatabase(storage));
  await ctx.plugin(SqliteSessionQueryEngine, {path: ':durable-object:', openAt: 'first-search'});
}
