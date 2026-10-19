import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {SessionControlFrame, SessionListValue, SessionSearchValue} from '@deepseek-ai/dsh-api-session-controller/types';
import {createRuntime, tenantId, url, type User} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {modelGate} from './browser/model-gate.ts';

type Api = ReturnType<typeof nativeClient>;
async function environment(runtime: ReturnType<typeof createRuntime>, id: string, user: User = 'alpha') {
  const response = await runtime.dispatchFetch(url(user, `/v1/tenants/${tenantId(user)}/environments`), {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id, name: id}),
  });
  assert.equal(response.status, 201, await response.clone().text());
}
async function prompt(api: Api, id: string, text: string) {
  await api.call('session/create', {request: {sessionId: id}});
  const follow = await api.follow(id);
  try {
    await follow.next();
    await api.call('session/prompt', {request: {sessionId: id, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
  } finally {await follow.close();}
}

test('official search reads actual scoped message logs and restores its derived index without activating cold Agents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-search-'));
  let runtime = createRuntime(directory);
  const one = nativeClient(() => runtime, 'one');
  try {
    await environment(runtime, 'one'); await environment(runtime, 'two'); await environment(runtime, 'one', 'beta');
    await prompt(one, 'same-session', 'authorized needle alpha');
    await prompt(nativeClient(() => runtime, 'two'), 'same-session', 'foreign environment secret needle');
    await prompt(nativeClient(() => runtime, 'one', 'beta'), 'same-session', 'foreign tenant secret needle');
    const result = await one.call<SessionSearchValue>('session/search', {request: {query: 'needle'}});
    assert.deepEqual(result, {items: [{sessionId: 'same-session', snippet: 'authorized needle alpha'}], hasMore: false});
    assert.equal((await one.call<SessionSearchValue>('session/search', {request: {query: 'needle OR foreign'}})).items.length, 0, 'query operators are literal text');
    for (const query of ['', '  ', '\u0000', 'x'.repeat(501)]) {
      assert.equal((await one.raw('session/search', {request: {query}})).result.error?.code, 'gateway/bad-request');
    }
    await runtime.dispose(); runtime = createRuntime(directory);
    const before = await one.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(before.items[0]!.agentAvailable, false);
    assert.deepEqual(await one.call('session/search', {request: {query: 'needle'}}), result);
    const after = await one.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(after.items[0]!.agentAvailable, false);
    assert.equal(after.items[0]!.running, false);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('searching an active turn neither closes it nor takes its real writer or model lifecycle', async () => {
  const gate = modelGate();
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'search-fixture', DEEPSEEK_BASE_URL: 'https://browser-model.test/anthropic'}, outbound: gate.outbound});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<Api['follow']>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'running'}});
    follow = await api.follow('running'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'running', requestId: 'running-search', mode: 'queue', content: [{type: 'text', text: 'active searchable needle'}]}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'step/start') break;}
    const deadline = Date.now() + 10000;
    while (!gate.calls()) {
      if (Date.now() > deadline) throw new Error('Model transport did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const snapshot = async () => {
      const observer = await api.follow('running');
      try {const frame = await observer.next(); assert.equal(frame.type, 'snapshot'); if (frame.type !== 'snapshot') throw new Error('Missing native snapshot'); return frame;}
      finally {await observer.close();}
    };
    const before = await snapshot();
    const hits = await api.call<SessionSearchValue>('session/search', {request: {query: 'searchable'}});
    assert.equal(hits.items[0]!.sessionId, 'running');
    const after = await snapshot();
    assert.deepEqual(after.records, before.records, 'search cannot append crash-recovery closers to an active log');
    assert.equal(after.cursor, before.cursor);
    const listed = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(listed.items[0]!.running, true); assert.equal(listed.items[0]!.agentAvailable, true);
    gate.release();
    for (;;) {
      const frame = await follow.next();
      if (frame.type === 'event' && frame.event.type === 'turn/end') {assert.equal((frame.event.data as {reason: {kind: string}}).reason.kind, 'completed'); break;}
    }
    assert.equal(gate.calls(), 2);
  } finally {gate.release(); await follow?.close(); await runtime.dispose();}
});

test('session directory, control baseline and search include sessions beyond the old 200-row cutoff', {timeout: 300000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  let control: Awaited<ReturnType<typeof api.stream<SessionControlFrame>>> | undefined;
  try {
    await prompt(api, 'oldest', 'oldest searchable needle');
    for (let offset = 0; offset < 204; offset += 4) {
      await Promise.all(Array.from({length: Math.min(4, 204 - offset)}, (_, index) => api.call('session/create', {request: {sessionId: 'blank-' + (offset + index)}})));
    }
    const listed = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(listed.items.length, 205); assert.ok(listed.items.some(item => item.sessionId === 'oldest'));
    assert.equal(listed.items.filter(item => item.agentAvailable).length, 1, 'blank directory entries do not activate Agents');
    const result = await api.call<SessionSearchValue>('session/search', {request: {query: 'oldest'}});
    assert.deepEqual(result, {items: [{sessionId: 'oldest', snippet: 'oldest searchable needle'}], hasMore: false});
    control = await api.stream<SessionControlFrame>('session/control', {});
    const frame = await control.next();
    assert.equal(frame.type, 'baseline');
    if (frame.type !== 'baseline') throw new Error('Missing control baseline');
    assert.equal(Object.keys(frame.value.projections).length, 205);
  } finally {await control?.close(); await runtime.dispose();}
});
