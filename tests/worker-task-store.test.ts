import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerTaskStore, type TaskRequest} from '../apps/web/src/official/worker-task-store.ts';
import type {JavaScriptStatus} from '../packages/workspace/src/javascript.ts';

test('cards share one Session read, fetch expanded details once, pause hidden and abort after unmount', async () => {
  const calls: string[] = [];
  let hidden = false, ended = false;
  const task: JavaScriptStatus = {id: crypto.randomUUID(), status: 'waiting', stdout: 'large output', stderr: '', pending: []};
  const request: TaskRequest = async (_session, operation, id, signal) => {
    calls.push(operation+':'+(id ?? '*'));
    await delay(5, undefined, {signal});
    return operation === 'list' ? {tasks: [{id: task.id, status: task.status, pending: []}]} : task;
  };
  const store = new WorkerTaskStore('session-a', request, () => hidden, () => {ended = true;});
  const stops = [store.subscribe(() => {}), store.subscribe(() => {}, task.id), store.subscribe(() => {}, task.id)];
  try {
    await delay(30);
    assert.deepEqual(calls, ['list:*']);
    stops.push(store.subscribe(() => {}, task.id, true), store.subscribe(() => {}, task.id, true));
    await delay(30);
    assert.deepEqual(calls, ['list:*', 'list:*', 'status:'+task.id]);
    assert.equal(store.getSnapshot().details.get(task.id)?.stdout, 'large output');
    hidden = true; store.refresh(false); await delay(20);
    assert.equal(calls.length, 3);
    hidden = false; store.refresh(false); await delay(30);
    assert.equal(calls.filter(call => call.startsWith('list')).length, 3);
    store.refresh(); await delay(2);
  } finally {for (const stop of stops) stop();}
  await delay(20); assert.equal(ended, true);
  assert.equal(store.getSnapshot().error, false);
});

test('shared cancellation keeps mutation errors until explicit refresh and never mixes Session stores', async () => {
  const task: JavaScriptStatus = {id: crypto.randomUUID(), status: 'waiting', stdout: '', stderr: '', pending: []};
  const request: TaskRequest = async (session, operation) => {
    if (operation === 'cancel') throw new Error('temporary failure');
    return {tasks: session === 'a' ? [task] : []};
  };
  const a = new WorkerTaskStore('a', request, () => false, () => {});
  const b = new WorkerTaskStore('b', request, () => false, () => {});
  const stops = [a.subscribe(() => {}), b.subscribe(() => {})];
  try {
    await delay(15); await a.cancel(task.id); await delay(15);
    assert.equal(a.getSnapshot().error, true); assert.equal(b.getSnapshot().error, false);
    assert.equal(b.getSnapshot().value?.tasks.length, 0);
    a.refresh(); await delay(15); assert.equal(a.getSnapshot().error, false);
  } finally {for (const stop of stops) stop();}
});
