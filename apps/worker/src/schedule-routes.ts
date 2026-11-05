import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import scheduleRemote from '../../../.generated/official-remotes/packages/schedule/schedule/typert.remote-client.js';
import { mapConcurrent } from '../../../packages/native-query/src/concurrent.ts';

type ScheduleEndpoint = keyof typeof scheduleRemote.methods;

/** How the entry Worker reaches the Schedule stores, one per root SessionDO. */
export interface ScheduleStores {
  /** Root Sessions of the environment. */
  sessions(): Promise<readonly string[]>;
  /** One Session's tasks, read without activating its Agent. */
  catalog(sessionId: string): Promise<ScheduleCatalogEntry[]>;
  /** Run this Remote call on one Session's live Schedule service. */
  call(sessionId: string): Promise<unknown>;
  /** Move the full task and its receipts to another executor, with crash recovery. */
  retarget(source: string, target: string, request: unknown): Promise<unknown>;
}

const SESSION_FAN_OUT = 16;
/** The original service's list page bounds. */
const DEFAULT_LIST_LIMIT = 100, MAX_LIST_LIMIT = 500;

/** The original catalog order: active tasks by next occurrence, then the others by most recent activity. */
function compareEntries(left: ScheduleCatalogEntry, right: ScheduleCatalogEntry): number {
  const status = Number(left.status !== 'active') - Number(right.status !== 'active');
  if (status !== 0) return status;
  if (left.status === 'active' && right.status === 'active') return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id);
  const leftRecent = left.lastDelivery?.deliveredAt ?? left.updatedAt ?? left.createdAt ?? left.scheduledAt;
  const rightRecent = right.lastDelivery?.deliveredAt ?? right.updatedAt ?? right.createdAt ?? right.scheduledAt;
  return rightRecent.localeCompare(leftRecent) || left.id.localeCompare(right.id);
}

/**
 * The original Host-wide Schedule Remote over Weft's per-Session stores. Each
 * task lives in the SessionDO it delivers to: reads aggregate every store,
 * task operations run on the owning store; cross-Session edits move the task
 * through the environment's journal. Creation runs on its target
 * Session. A SessionDO creates no other Session, so a target that would create
 * one is refused with the original Schedule message.
 * @returns the method's result value, validated by its wire codec.
 */
export async function routeSchedule(endpoint: ScheduleEndpoint, raw: unknown, stores: ScheduleStores, signal: AbortSignal): Promise<unknown> {
  const method = scheduleRemote.methods[endpoint];
  const args = method.input({strict: true}).create().parse(raw) as {request?: Record<string, unknown>};
  const request = args.request ?? {};
  const all = async () => {
    const sessions = await stores.sessions();
    return (await mapConcurrent(sessions, async sessionId => (await stores.catalog(sessionId)).map(entry => ({sessionId, entry})), signal, SESSION_FAN_OUT)).flat();
  };
  const result = (value: unknown) => method.result.create().parse(value);
  switch (endpoint) {
    case 'schedule/catalog': return result((await all()).map(row => row.entry).sort(compareEntries));
    case 'schedule/list': {
      const limit = typeof request.limit === 'number' ? request.limit : DEFAULT_LIST_LIMIT, offset = typeof request.offset === 'number' ? request.offset : 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
        throw new RemoteError('schedule/input-invalid', `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`, {code: 'invalid_rule'});
      }
      const items = (await all()).map(row => row.entry).sort(compareEntries).filter(entry => request.active === undefined || (entry.status === 'active') === request.active);
      const page = items.slice(offset, offset + limit);
      return result({items: page, shown: page.length, total: items.length, limit, offset});
    }
    case 'schedule/deleteInactive': {
      const owners = [...new Set((await all()).filter(row => row.entry.status === 'ended').map(row => row.sessionId))];
      const removed = await mapConcurrent(owners, async sessionId => (await stores.call(sessionId) as {deleted: number}).deleted, signal, SESSION_FAN_OUT);
      return result({deleted: removed.reduce((sum, count) => sum + count, 0)});
    }
    case 'schedule/deliveryLimits': {
      const [first] = await stores.sessions();
      // Every store mounts the same Schedule configuration; without a Session the original default applies.
      return result(first === undefined ? {newSessionIntervalSeconds: 60} : await stores.call(first));
    }
    case 'schedule/create': {
      const target = request.target as {kind?: string; sessionId?: string} | undefined;
      if (target?.kind !== 'session' || typeof target.sessionId !== 'string') {
        throw new RemoteError('schedule/input-invalid', 'This Host cannot create Sessions; choose an existing Session target.', {code: 'invalid_rule'});
      }
      if (!(await stores.sessions()).includes(target.sessionId)) {
        throw new RemoteError('schedule/input-invalid', `target Session "${target.sessionId}" does not exist.`, {code: 'invalid_rule'});
      }
      return result(await stores.call(target.sessionId));
    }
    case 'schedule/view': case 'schedule/edit': case 'schedule/history': case 'schedule/run': {
      const id = request.id;
      const owner = (await all()).find(row => row.entry.id === id)?.sessionId;
      if (owner === undefined) return result({id, code: 'schedule_not_found'});
      if (endpoint === 'schedule/edit' && request.action === 'update') {
        const target = (request.patch as {target?: {kind: string; sessionId?: string}})?.target;
        if (target?.kind === 'session' && target.sessionId !== owner) {
          if (!target.sessionId || !(await stores.sessions()).includes(target.sessionId)) throw new RemoteError('schedule/input-invalid', 'Target Session does not exist in this environment.', {code: 'invalid_rule'});
          return result(await stores.retarget(owner, target.sessionId, request));
        }
      }
      return result(await stores.call(owner));
    }
    default: {
      const unreachable: never = endpoint;
      throw new RemoteError('gateway/method-unavailable', 'Unknown Schedule method', {endpoint: String(unreachable)});
    }
  }
}
