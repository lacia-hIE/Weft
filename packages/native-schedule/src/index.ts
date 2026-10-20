import { Service, type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import ScheduleService from '@deepseek-ai/dsh-schedule';
import { mountDurableStorage } from '../../native-storage/src/index.ts';

/**
 * The `resolveAgent` capability Schedule delivery uses. A SessionDO owns exactly
 * its root Agent and the children it hosts. Like the original controller, a
 * Session this object is still restoring resolves once its Agent exists;
 * Sessions owned by other objects are reported missing.
 */
export class NativeSessionAgents extends Service {
  static inject = ['agents'];
  constructor(ctx: Context, private readonly options: {restoring: (sessionId: SessionId) => Promise<boolean>}) { super(ctx, 'sessionController'); }
  async resolveAgent(sessionId: SessionId): Promise<{agent: Agent} | {error: RemoteError}> {
    const agent = this.ctx.agents.get(sessionId) ?? (await this.options.restoring(sessionId) ? this.ctx.agents.get(sessionId) : undefined);
    return agent ? {agent} : {error: new RemoteError('session/not-found', 'Session not found', {sessionId})};
  }
}

/** The DO alarm mirrors the earliest active reminder so delivery survives eviction. */
export interface ScheduleAlarm { set(at: number | undefined): Promise<void> }

/** Mount the original Schedule service over this DO's storage, woken by its alarm. */
export async function mountNativeSchedule(ctx: Context, storage: DurableObjectStorage, alarm: ScheduleAlarm, root: SessionId): Promise<void> {
  await mountDurableStorage(ctx, storage);
  // The root Agent is created or resumed after plugins mount; delivery waits for it.
  const ready = Promise.withResolvers<void>();
  ctx.on('agent/created', ({agent}) => {if (agent.id === root) ready.resolve();}, {global: true});
  await ctx.plugin(NativeSessionAgents, {restoring: async sessionId => {
    if (sessionId !== root) return false;
    await Promise.race([ready.promise, new Promise(resolve => setTimeout(resolve, 30_000))]);
    return true;
  }});
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

/** The `schedule/catalog` rows this DO stores, read without activating an Agent. */
export function readScheduleCatalog(storage: DurableObjectStorage): unknown[] {
  const exists = storage.sql.exec<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='weft_kv_u_schedule_tasks'").toArray().length > 0;
  if (!exists) return [];
  return storage.sql.exec<{value: string}>('SELECT value FROM weft_kv_u_schedule_tasks').toArray().map(row => {
    const task = JSON.parse(row.value) as {sessionId: string; record: Record<string, unknown>; status?: string; lastDelivery?: unknown};
    return {...task.record, sessionId: task.sessionId, status: task.status ?? 'active', ...(task.lastDelivery === undefined ? {} : {lastDelivery: task.lastDelivery})};
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
