import {isDeepStrictEqual} from 'node:util';
import {ScheduleInputError} from '@deepseek-ai/dsh-schedule';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import {updateScheduleRecord} from '@weft/upstream/packages/schedule/schedule/src/update.ts';
import {scheduleTaskSchema, type ScheduleTask} from '@weft/upstream/packages/schedule/schedule/src/storage.ts';
import type {ScheduleEditRequest} from '@deepseek-ai/dsh-schedule';

/** A transfer is persisted before removing the old executor's task. */
export interface ScheduleTransfer {token: string; request: ScheduleEditRequest; task: ScheduleTask}
export function prepareScheduleTransfer(raw: unknown, request: ScheduleEditRequest, target: string): ScheduleTransfer | {id: string; code: 'schedule_conflict'} {
  if (request.action !== 'update') throw new Error('Only updates can transfer tasks');
  const current = scheduleTaskSchema.parse(raw);
  if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) return {id: request.id, code: 'schedule_conflict'};
  // Use the original evaluator: changing an instruction never resets its clock or receipts.
  const now = Date.now(), patch = request.patch;
  let record;
  try {record = updateScheduleRecord(current.record, patch, now, patch.active === true);}
  catch (error) {if (error instanceof ScheduleInputError) throw new RemoteError('schedule/input-invalid', error.message, {code: error.code}); throw error;}
  const changedRule = !isDeepStrictEqual({...record, title: current.record.title, prompt: current.record.prompt}, current.record);
  let status = current.status;
  if (patch.active === false) status = 'paused';
  else if (patch.active === true || changedRule && current.status === 'ended') status = 'active';
  const {pendingDelivery: _pending, ...kept} = current;
  const task = scheduleTaskSchema.parse({...kept, record, target: {kind: 'session', sessionId: target},
    involvedSessionIds: [...new Set([...current.involvedSessionIds, target])], status,
    updatedAt: new Date(Math.max(now, current.updatedAt === undefined ? now : Date.parse(current.updatedAt) + 1)).toISOString()});
  return {token: crypto.randomUUID(), request, task};
}
export function transferError(message: string): never {
  throw new RemoteError('schedule/input-invalid', message, {code: 'invalid_rule'});
}
