import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionPage } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** The 0.2.2 schedule tool takes RFC 5545 timing: one UTC occurrence `delayMs` from now. */
function oneShotRule(delayMs: number): string {
  const at = new Date(Math.ceil((Date.now() + delayMs) / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `DTSTART:${at}\nRRULE:FREQ=DAILY;COUNT=1`;
}

/** Only model HTTP is scripted; the original schedule tool, service and DO alarm deliver the reminder. */
function scheduleModel() {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://schedule-model.test') throw new Error('Unexpected schedule fixture outbound request');
    const body = JSON.stringify(await request.json());
    const reminder = body.includes('REMINDER_ALPHA') && !body.includes('SCHEDULE_TASK');
    const tool = body.includes('SCHEDULE_TASK') && !body.includes('tool_result');
    const args = JSON.stringify({prompt: 'REMINDER_ALPHA', title: 'Alpha reminder', rrule: oneShotRule(2_000), target: 'this_session'});
    const text = reminder || body.includes('REMINDER_ALPHA') && body.lastIndexOf('REMINDER_ALPHA') > body.lastIndexOf('tool_result') ? 'REMINDED' : 'SCHEDULED';
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'schedule', name: 'schedule_create', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

test('the original schedule tool arms a Durable Object alarm that delivers its reminder after workerd restarts', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-schedule-'));
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'schedule-fixture', DEEPSEEK_BASE_URL: 'https://schedule-model.test/anthropic'}, outbound: scheduleModel().outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const page = async () => {
    const projections = await api.call<{asOfSeq: number}>('session/projections', {request: {sessionId: 'reminded'}});
    return (await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: 'reminded'}, throughSeq: projections.asOfSeq}})).records.map(record => record.event);
  };
  try {
    await api.call('session/create', {request: {sessionId: 'reminded'}});
    const follow = await api.follow('reminded');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'reminded', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'SCHEDULE_TASK'}]}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await follow.close();

    // 0.2.2 manages Host tasks by id; the environment aggregates the stores of its Sessions.
    const listed = await api.call<{items: {id: string; title: string}[]; total: number}>('schedule/list', {request: {active: true}});
    assert.deepEqual(listed.items.map(record => record.title), ['Alpha reminder']);
    const catalog = await api.call<{id: string; target: {kind: string; sessionId?: string}; status: string}[]>('schedule/catalog', {});
    assert.deepEqual(catalog.map(entry => [entry.id, entry.target.sessionId, entry.status]), [[listed.items[0]!.id, 'reminded', 'active']]);
    const viewed = await api.call<{id: string; title: string}>('schedule/view', {request: {id: listed.items[0]!.id}});
    assert.equal(viewed.title, 'Alpha reminder');
    assert.deepEqual(await api.call('schedule/view', {request: {id: 'schedule-missing'}}), {id: 'schedule-missing', code: 'schedule_not_found'});
    const refused = await api.raw('schedule/create', {request: {title: 'Fresh', prompt: 'NEW_SESSION', timing: {kind: 'rrule', rrule: oneShotRule(60_000)}}});
    assert.equal(refused.result.error?.code, 'schedule/input-invalid', 'a SessionDO creates no other Session');

    // Evict every object before the reminder is due; only the persisted alarm can wake the Session.
    await runtime.dispose();
    await delay(2_500);
    runtime = createRuntime(directory, options);
    let events: {type: string; data?: unknown}[] = [];
    for (const end = Date.now() + 30_000; Date.now() < end; await delay(250)) {
      events = await page();
      if (events.some(event => event.type === 'turn/end' && events.indexOf(event) > events.findIndex(item => item.type === 'user/message' && JSON.stringify(item.data).includes('"kind":"schedule"')) && events.some(item => item.type === 'user/message' && JSON.stringify(item.data).includes('"kind":"schedule"')))) break;
    }
    const delivered = events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes('"kind":"schedule"'));
    assert.ok(delivered, 'the alarm delivered the reminder as a schedule-sourced user message');
    assert.match(JSON.stringify(delivered), /REMINDER_ALPHA/);
    assert.equal((await api.call<{total: number}>('schedule/list', {request: {active: true}})).total, 0, 'a one-shot reminder ends after delivery');
    const ended = await api.call<{status: string; lastDelivery?: unknown}[]>('schedule/catalog', {});
    assert.equal(ended[0]?.status, 'ended');
    assert.ok(ended[0]?.lastDelivery, 'the delivery receipt is retained');
  } finally {
    await runtime.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});


test('a retained-runtime task moves to a current Session without resetting its identity, timing or history', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-schedule-transfer-'));
  const options = {browser: true, scriptPath: 'dist/environment-storage-worker.js', bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'schedule-fixture', DEEPSEEK_BASE_URL: 'https://schedule-model.test/anthropic'}, outbound: scheduleModel().outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'old-scheduler'}});
    await api.call('session/create', {request: {sessionId: 'new-scheduler'}});
    const task = await api.call<{id: string; updatedAt: string; scheduledAt: string}>('schedule/create', {request: {title: 'Retained task', prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(120_000)}, target: {kind: 'session', sessionId: 'old-scheduler'}}});
    const scope = {tenantId: tenantId('alpha'), environmentId: 'default', sessionId: 'old-scheduler'};
    assert.equal((await runtime.dispatchFetch(url('alpha', '/_fixture/session-revision'), {method: 'POST', body: JSON.stringify({scope, commit: 'b830ec950faba0a46dda564be3e2d854afed94f1'})})).status, 200);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.equal((await api.call<{id: string}>('schedule/view', {request: {id: task.id}})).id, task.id, 'the editor can inspect a task without activating its retired Agent');
    assert.deepEqual((await api.call<{records: unknown[]}>('schedule/history', {request: {id: task.id, limit: 10}})).records, []);
    assert.equal((await api.raw('schedule/history', {request: {id: task.id, limit: 0}})).result.ok, false);
    const invalid = await api.raw('schedule/edit', {request: {id: task.id, action: 'update', patch: {timing: {kind: 'rrule', rrule: 'invalid'}, target: {kind: 'session', sessionId: 'new-scheduler'}}}});
    assert.equal(invalid.result.ok, false, 'invalid timing cannot start a move');
    assert.equal((await api.call<{target: {sessionId: string}}>('schedule/view', {request: {id: task.id}})).target.sessionId, 'old-scheduler', 'a rejected move never blocks later global reads');
    const conflict = await api.call('schedule/edit', {request: {id: task.id, action: 'update', expectedUpdatedAt: '2000-01-01T00:00:00.000Z', patch: {target: {kind: 'session', sessionId: 'new-scheduler'}}}});
    assert.deepEqual(conflict, {id: task.id, code: 'schedule_conflict'});
    assert.equal((await runtime.dispatchFetch(url('alpha', '/_fixture/lifecycle'), {method: 'POST', body: JSON.stringify({scope: {...scope, sessionId: 'new-scheduler'}, kind: 'session', action: 'lose-import-response'})})).status, 200);
    const interrupted = await api.raw('schedule/edit', {request: {id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: {target: {kind: 'session', sessionId: 'new-scheduler'}}}});
    assert.equal(interrupted.result.ok, false, 'the import committed but its RPC response was lost');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    // Any global read recovers the journal and acknowledges the already imported token.
    const catalog = await api.call<{id: string; target: {sessionId: string}; scheduledAt: string}[]>('schedule/catalog', {});
    const moved = catalog.find(row => row.id === task.id)!;
    assert.equal(moved.id, task.id);
    assert.equal(moved.target.sessionId, 'new-scheduler');
    assert.equal(moved.scheduledAt, task.scheduledAt);
    assert.equal((await api.call<unknown[]>('schedule/catalog', {})).length, 1, 'one authoritative task remains');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const executed = await api.call<{lastDelivery?: unknown}>('schedule/run', {request: {id: task.id}});
    assert.ok(executed.lastDelivery);
    const history = await api.call<{records: {targetSessionId: string}[]}>('schedule/history', {request: {id: task.id, limit: 10}});
    assert.equal(history.records.at(-1)?.targetSessionId, 'new-scheduler');
    const old = await api.stream('session/follow', {request: {address: {kind: 'session', sessionId: 'old-scheduler'}, activate: false}});
    try {assert.equal((await old.next() as {type: string}).type, 'snapshot', 'the old Session remains readable');} finally {await old.close();}
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});


test('retargeting refuses a busy executor without interrupting its user turn or losing the task', {timeout: 120_000}, async () => {
  let started!: () => void, release!: () => void;
  const requestStarted = new Promise<void>(resolve => {started = resolve;}), released = new Promise<void>(resolve => {release = resolve;});
  const original = scheduleModel().outbound;
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'schedule-fixture', DEEPSEEK_BASE_URL: 'https://schedule-model.test/anthropic'},
    outbound: async (request, mf) => {started(); await released; return original(request, mf);}});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'busy-executor'}});
    await api.call('session/create', {request: {sessionId: 'idle-executor'}});
    const task = await api.call<{id: string}>('schedule/create', {request: {title: 'Keep running', prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(120_000)}, target: {kind: 'session', sessionId: 'busy-executor'}}});
    follow = await api.follow('busy-executor'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'busy-executor', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'BUSY_USER_TURN'}]}});
    await requestStarted;
    const rejected = await api.raw('schedule/edit', {request: {id: task.id, action: 'update', patch: {target: {kind: 'session', sessionId: 'idle-executor'}}}});
    assert.equal(rejected.result.ok, false);
    assert.equal((await api.call<{target: {sessionId: string}}>('schedule/view', {request: {id: task.id}})).target.sessionId, 'busy-executor');
    release();
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') {assert.equal((frame.event.data as {reason: {kind: string}}).reason.kind, 'completed'); break;}}
    const run = await api.call<{lastDelivery: {targetSessionId: string}}>('schedule/run', {request: {id: task.id}});
    assert.equal(run.lastDelivery.targetSessionId, 'busy-executor', 'the original scheduler remains usable');
  } finally {release(); await follow?.close(); await runtime.dispose();}
});

test('retired-runtime tasks can be deleted individually and cleaned up without running their Agent', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-schedule-delete-'));
  let modelCalls = 0;
  const model = scheduleModel().outbound;
  const options = {browser: true, scriptPath: 'dist/environment-storage-worker.js', bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'schedule-fixture', DEEPSEEK_BASE_URL: 'https://schedule-model.test/anthropic'},
    outbound: (async (request, mf) => {modelCalls++; return model(request, mf);}) as V4FetchHandler};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const scope = {tenantId: tenantId('alpha'), environmentId: 'default', sessionId: 'retired-deletions'};
  const snapshot = async () => {
    const stream = await api.stream('session/follow', {request: {address: {kind: 'session', sessionId: scope.sessionId}, activate: false}});
    try {return await stream.next();} finally {await stream.close();}
  };
  const alarm = async () => (await (await runtime.dispatchFetch(url('alpha', '/_fixture/lifecycle'), {method: 'POST', body: JSON.stringify({scope, kind: 'session'})})).json() as {alarm: number | null}).alarm;
  try {
    await api.call('session/create', {request: {sessionId: scope.sessionId}});
    await api.call('session/create', {request: {sessionId: 'current-deletions'}});
    const create = (sessionId: string, title: string, delayMs = 300_000) => api.call<{id: string; updatedAt: string}>('schedule/create', {request: {title, prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(delayMs)}, target: {kind: 'session', sessionId}}});
    const single = await create(scope.sessionId, 'Delete this old task');
    const paused = await create(scope.sessionId, 'Keep paused until explicitly deleted');
    await api.call('schedule/edit', {request: {id: paused.id, action: 'update', patch: {active: false}}});
    const active = await create(scope.sessionId, 'Keep active');
    const ended = await create(scope.sessionId, 'Old ended task', 1500);
    const currentEnded = await create('current-deletions', 'Current ended task', 1500);
    for (const end = Date.now() + 20_000; ;) {
      const tasks = await api.call<{id: string; status: string}[]>('schedule/catalog', {});
      if ([ended.id, currentEnded.id].every(id => tasks.some(task => task.id === id && task.status === 'ended'))) break;
      assert.ok(Date.now() < end, 'the fixture tasks end before retirement'); await delay(100);
    }
    assert.equal((await runtime.dispatchFetch(url('alpha', '/_fixture/session-revision'), {method: 'POST', body: JSON.stringify({scope, commit: 'b830ec950faba0a46dda564be3e2d854afed94f1', legacySchedules: true})})).status, 200);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const before = await snapshot(), callsBefore = modelCalls;
    assert.deepEqual(await api.call('schedule/edit', {request: {id: single.id, action: 'delete', expectedUpdatedAt: '2000-01-01T00:00:00.000Z'}}), {id: single.id, code: 'schedule_conflict'});
    assert.equal((await api.call<{id: string}>('schedule/view', {request: {id: single.id}})).id, single.id);
    assert.deepEqual(await api.call('schedule/edit', {request: {id: single.id, action: 'delete', expectedUpdatedAt: single.updatedAt}}), {id: single.id, deleted: true});
    assert.deepEqual(await api.call('schedule/edit', {request: {id: single.id, action: 'delete'}}), {id: single.id, code: 'schedule_not_found'});
    assert.deepEqual(await api.call('schedule/deleteInactive', {}), {deleted: 2}, 'cleanup spans both current and retired stores');
    assert.deepEqual((await api.call<{id: string}[]>('schedule/catalog', {})).map(task => task.id).sort(), [active.id, paused.id].sort(), 'cleanup keeps active and paused tasks');
    assert.deepEqual(await api.call('schedule/deleteInactive', {}), {deleted: 0});
    assert.notEqual(await alarm(), null, 'another active task keeps its alarm');
    await api.call('schedule/edit', {request: {id: paused.id, action: 'delete'}});
    await api.call('schedule/edit', {request: {id: active.id, action: 'delete'}});
    assert.equal(await alarm(), null, 'removing the final active task clears the retired alarm');
    assert.equal(modelCalls, callsBefore, 'deletion never runs the retired Agent');
    assert.deepEqual(await snapshot(), before, 'deleting tasks preserves the old conversation history');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.deepEqual(await api.call('schedule/catalog', {}), [], 'deleted tasks remain deleted after restart');
    assert.deepEqual(await snapshot(), before);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
