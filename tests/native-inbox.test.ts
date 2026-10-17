import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionProjectionsValue, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url, type SessionResponse } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
function reply(text: string, tool = false): Response {
  return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'identity', name: 'tenant_identity', input: {}} : {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: '{}'} : {type: 'text_delta', text}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
}
const bindings = {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-inbox-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'};

test('native Inbox admits while running, edits/removes queued occurrences and steers into the next step on the same real Agent', {timeout: 60_000}, async () => {
  let started!: () => void, release!: () => void;
  const first = new Promise<void>(resolve => {started = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const requests: unknown[] = [];
  const outbound: V4FetchHandler = async request => {
    requests.push(await request.json());
    const tool = requests.length === 1;
    if (tool) {started(); await gate;}
    return reply('native response '+requests.length, tool);
  };
  const runtime = createRuntime(undefined, {browser: true, bindings, outbound});
  const api = nativeClient(() => runtime);
  const ids = Object.fromEntries(['a','b','c','d','e'].map(name => [name, randomUUID()]));
  const prompt = (name: string, mode = 'queue') => ({request: {sessionId: 'inbox', requestId: ids[name], mode, content: [{type: 'text', text: name}]}});
  const projections = async () => {
    const value = await api.call<SessionProjectionsValue>('session/projections', {request: {sessionId: 'inbox'}});
    if (value?.kind !== 'sequenced' || !value.values.inbox) throw new Error('Missing native inbox projection');
    return value;
  };
  try {
    await api.call('session/create', {request: {sessionId: 'inbox'}});
    await api.call('session/prompt', prompt('a'));
    await first;
    for (const name of ['b','c','d']) await api.call('session/prompt', prompt(name));
    const pending = (await projections()).values.inbox!;
    assert.equal(pending['next-turn'].length, 3);
    const messages = pending['next-turn'] as {id: string; source: {rpcId: string}}[];
    const item = (name: string) => messages.find(message => message.source.rpcId === ids[name])!.id;
    await api.call('session/updateQueue', {request: {sessionId: 'inbox', itemId: item('b'), action: {kind: 'edit', content: [{type: 'text', text: 'b edited'}]}}});
    await api.call('session/updateQueue', {request: {sessionId: 'inbox', itemId: item('c'), action: {kind: 'remove'}}});
    await api.call('session/prompt', prompt('c')); // receipt retry cannot recreate a removed occurrence
    await api.call('session/updateQueue', {request: {sessionId: 'inbox', itemId: item('d'), action: {kind: 'steer'}}});
    await api.call('session/prompt', prompt('e', 'steer'));
    const edited = (await projections()).values.inbox!;
    assert.equal(edited['next-turn'].length, 1);
    assert.equal(edited['next-step'].length, 2);
    assert.match(JSON.stringify(edited['next-turn']), /b edited/);
    assert.equal((await api.raw('session/updateQueue', {request: {sessionId: 'inbox', itemId: item('c'), action: {kind: 'remove'}}})).result.error?.code, 'session/queue-item-not-found');
    assert.equal((await api.raw('session/updateQueue', {request: {sessionId: 'inbox', itemId: item('b'), action: {kind: 'edit', content: [{type: 'text', text: '  '}]}}})).result.error?.code, 'gateway/bad-request');
    release();
    const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/inbox/events`));
    assert.equal(response.status, 200);
    const {events} = await response.json() as SessionResponse;
    assert.equal(requests.length, 3);
    const ends = events.filter(record => record.type === 'turn/end');
    assert.equal(ends.length, 2);
    const user = events.filter(record => record.type === 'user/message');
    assert.ok(!user.some(record => JSON.stringify(record.data).includes(ids.c!)));
    for (const name of ['a','d','e']) assert.ok(user.find(record => JSON.stringify(record.data).includes(ids[name]!))!.seq < ends[0]!.seq);
    const b = user.find(record => JSON.stringify(record.data).includes(ids.b!))!;
    assert.ok(b.seq > ends[0]!.seq); assert.match(JSON.stringify(b.data), /b edited/);
    const stable = await projections();
    assert.deepEqual(stable.values.inbox, {'next-turn': [], 'next-step': []});
    const list = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(list.items[0]!.running, false);
    assert.equal(list.items[0]!.agentAvailable, true, 'idle does not dispose the native host');
    const before = events.filter(record => record.type === 'session/end-seed').length;
    assert.ok(before > 0);
    await api.call('session/prompt', {request: {sessionId: 'inbox', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'another turn'}]}});
    const next = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/inbox/events`));
    const after = await next.json() as SessionResponse;
    assert.equal(after.events.filter(record => record.type === 'session/end-seed').length, before, 'another turn reuses the root and writer');
  } finally {release(); await runtime.dispose();}
});

test('native cancellation aborts the active turn and preserves already admitted follow-up work', {timeout: 60_000}, async () => {
  let started!: () => void;
  const first = new Promise<void>(resolve => {started = resolve;});
  let count = 0;
  const runtime = createRuntime(undefined, {browser: true, bindings, outbound: async () => {
    if (++count !== 1) return reply('follow-up survived');
    started();
    return new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(event('message_start', {message: {usage: {input_tokens: 1, output_tokens: 0}}})));}}), {headers: {'content-type': 'text/event-stream'}});
  }});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'cancel-queue'}});
    for (const text of ['first','second']) {
      await api.call('session/prompt', {request: {sessionId: 'cancel-queue', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      if (text === 'first') await first;
    }
    await api.call('session/cancel', {request: {sessionId: 'cancel-queue'}});
    const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/cancel-queue/events`));
    const {events} = await response.json() as SessionResponse;
    assert.equal(count, 1, 'native cancellation parks admitted input until a new wake');
    const parked = await api.call<SessionProjectionsValue>('session/projections', {request: {sessionId: 'cancel-queue'}});
    assert.equal(parked?.kind, 'sequenced');
    if (parked?.kind !== 'sequenced') throw new Error('Missing queue projections');
    assert.equal(parked.values.inbox?.['next-turn'].length, 1);
    const ends = events.filter(record => record.type === 'turn/end');
    assert.match(JSON.stringify(ends[0]!.data), /aborted.*user/);
    await api.call('session/prompt', {request: {sessionId: 'cancel-queue', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'continue'}]}});
    const resumed = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/cancel-queue/events`));
    const recovered = await resumed.json() as SessionResponse;
    assert.equal(count, 3, 'each next-turn occurrence retains its own turn');
    const recoveredEnds = recovered.events.filter(record => record.type === 'turn/end');
    assert.equal(recoveredEnds.length, 3);
    assert.match(JSON.stringify(recoveredEnds[1]!.data), /completed/);
    assert.match(JSON.stringify(recoveredEnds[2]!.data), /completed/);
    assert.match(JSON.stringify(recovered.events), /follow-up survived/);
    assert.equal(recovered.events.filter(record => record.type === 'user/message' && JSON.stringify(record.data).includes('second')).length, 1);
  } finally {await runtime.dispose();}
});
