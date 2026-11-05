import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import ScheduleService, { type ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import { scheduleTaskSchema } from '@weft/upstream/packages/schedule/schedule/src/storage.ts';
import { mountDurableStorage } from '../../native-storage/src/index.ts';

/**
 * Schedule delivery restores Sessions through `schedule/resolve-agent`. A
 * SessionDO owns exactly its root Agent and the children it hosts; like the
 * original controller, a Session this object is still restoring resolves once
 * its Agent exists, and Sessions owned by other objects are reported missing.
 * No `sessionController` is provided, so Schedule refuses targets that would
 * create a Session, with its original message.
 */
function resolveScheduleAgents(ctx: Context, restoring: (sessionId: SessionId) => Promise<boolean>): void {
  ctx.on('schedule/resolve-agent', async sessionId => {
    const agent = ctx.agents.get(sessionId) ?? (await restoring(sessionId) ? ctx.agents.get(sessionId) : undefined);
    if (!agent) throw new RemoteError('session/not-found', 'Session not found', {sessionId});
    return agent;
  });
}

/** The DO alarm mirrors the earliest active reminder so delivery survives eviction. */
export interface ScheduleAlarm { set(at: number | undefined): Promise<void> }

/** Mount the original Schedule service over this DO's storage, woken by its alarm. */
export async function mountNativeSchedule(ctx: Context, storage: DurableObjectStorage, alarm: ScheduleAlarm, root: SessionId): Promise<void> {
  await mountDurableStorage(ctx, storage);
  // The root Agent is created or resumed after plugins mount; delivery waits for it.
  const ready = Promise.withResolvers<void>();
  ctx.on('agent/created', ({agent}) => {if (agent.id === root) ready.resolve();}, {global: true});
  resolveScheduleAgents(ctx, async sessionId => {
    if (sessionId !== root) return false;
    await Promise.race([ready.promise, new Promise(resolve => setTimeout(resolve, 30_000))]);
    return true;
  });
  await ctx.plugin(ScheduleService, {});
  const sync = async () => {
    const schedule = ctx.get('schedule');
    if (!schedule) return;
    const due = (await schedule.catalog()).filter(entry => entry.status === 'active').map(entry => Date.parse(entry.scheduledAt));
    await alarm.set(due.length ? Math.min(...due) : undefined);
  };
  let pending = Promise.resolve();
  const queue = () => { pending = pending.then(sync).catch(error => { ctx.logger('schedule').warn(`schedule: alarm sync failed: ${String(error)}`); }); };
  ctx.on('schedule/changed', queue);
  ctx.inject(['schedule'], () => { queue(); });
}

/**
 * The `schedule/catalog` entries this DO stores, read without activating an
 * Agent: each row is read through the original task schema, which also accepts
 * version 1 rows, and projected as the service's catalog entry without live
 * execution state.
 */
export function readScheduleCatalog(storage: DurableObjectStorage): ScheduleCatalogEntry[] {
  const exists = storage.sql.exec<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='weft_kv_u_schedule_tasks'").toArray().length > 0;
  if (!exists) return [];
  return storage.sql.exec<{value: string}>('SELECT value FROM weft_kv_u_schedule_tasks').toArray().map(row => {
    const task = scheduleTaskSchema.parse(JSON.parse(row.value));
    return {
      ...task.record, target: task.target, involvedSessionIds: [...task.involvedSessionIds], status: task.status,
      ...(task.createdAt === undefined ? {} : {createdAt: task.createdAt}),
      ...(task.updatedAt === undefined ? {} : {updatedAt: task.updatedAt}),
      ...(task.lastDelivery === undefined ? {} : {lastDelivery: task.lastDelivery}),
    } as ScheduleCatalogEntry;
  });
}

/** Wait until the woken Schedule runtime has delivered every reminder already due. */
export async function drainDueReminders(ctx: Context, deadlineMs = 10_000): Promise<void> {
  const schedule = ctx.get('schedule');
  if (!schedule) return;
  for (const end = Date.now() + deadlineMs; Date.now() < end;) {
    const now = Date.now();
    if (!(await schedule.catalog()).some(entry => entry.status === 'active' && Date.parse(entry.scheduledAt) <= now)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
