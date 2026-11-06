import type {ScheduleEditRequest} from '@deepseek-ai/dsh-schedule';
import {readScheduleCatalog} from './index.ts';

/** Cold stores use the same lookup, optimistic revision and ended-only deletion rules as ScheduleService. */
export function deleteStoredSchedules(storage: DurableObjectStorage, request?: Extract<ScheduleEditRequest, {action: 'delete'}>): {value: unknown; changed: boolean} {
  return storage.transactionSync(() => {
    const tasks = readScheduleCatalog(storage);
    const task = request && tasks.find(task => task.id === request.id);
    if (request && !task) return {value: {id: request.id, code: 'schedule_not_found'}, changed: false};
    if (request && request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (task!.updatedAt ?? null)) return {value: {id: request.id, code: 'schedule_conflict'}, changed: false};
    const removed = task ? [task] : tasks.filter(task => task.status === 'ended');
    if (removed.length) {
      for (const task of removed) storage.sql.exec('DELETE FROM weft_kv_u_schedule_tasks WHERE key=?', task.id);
      // The first mutation of a v1 store stamps v2 together with its data.
      storage.sql.exec("UPDATE weft_kv_units SET version=2 WHERE name='schedule'");
    }
    return {value: request ? {id: request.id, deleted: true} : {deleted: removed.length}, changed: removed.length > 0};
  });
}
