import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { Response } from 'miniflare';
import type { SessionFollowFrame, SessionPage, SessionCreateValue, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';

type Runtime = ReturnType<typeof createRuntime>;
function client(runtime: () => Runtime, environment = 'default', user = 'alpha' as const) {
  const base = `/v1/tenants/${tenantId(user)}/environments/${environment}/native`;
  return {
    async raw(endpoint: string, args: unknown, method = endpoint) {
      const response = await runtime().dispatchFetch(url(user, `${base}/api/${endpoint}`), {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({type: 'client-request', rpcId: 'fixture-rpc', method, payload: {args}}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      return await response.json() as {rpcId: string; result: {ok: boolean; value: unknown; error?: {code: string}}};
    },
    async call<T>(endpoint: string, args: unknown): Promise<T> {
      const body = await this.raw(endpoint, args);
      assert.equal(body.result.ok, true, JSON.stringify(body));
      assert.equal(body.rpcId, 'fixture-rpc');
      return body.result.value as T;
    },
    async follow(sessionId: string) {
      const response = await runtime().dispatchFetch(url(user, `${base}/streams/session/follow`), {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({args: {request: {address: {kind: 'session', sessionId}, assistantStream: true}}}),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      return {
        async next(): Promise<SessionFollowFrame> {
          for (;;) {
            const end = pending.indexOf('\n\n');
            if (end >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
              assert.ok(data, frame);
              assert.ok(frame.startsWith('event: item'), data);
              return JSON.parse(data) as SessionFollowFrame;
            }
            const part = await reader.read();
            assert.equal(part.done, false, 'follow ended before the expected frame');
            pending += decoder.decode(part.value, {stream: true});
          }
        },
        close: () => reader.cancel(),
      };
    },
  };
}

test('official Session codecs expose real blank creation, live history, prompt correlation, titles and restart recovery in workerd', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-session-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = client(() => runtime);
  let stream: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    const created = await api.call<SessionCreateValue>('session/create', {request: {sessionId: 'native'}});
    assert.deepEqual(created, {sessionId: 'native', agentPreset: 'default'});
    assert.deepEqual(await api.call('session/create', {request: {sessionId: 'native'}}), created, 'a blank Session is reusable');
    const listed = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]!.blank, true);
    assert.equal(listed.items[0]!.cwd, '/workspace');
    stream = await api.follow('native');
    const opening = await stream.next();
    assert.equal(opening.type, 'snapshot');
    if (opening.type !== 'snapshot') throw new Error('Missing opening snapshot');
    assert.equal(opening.header.agentPreset, 'default');
    assert.equal(opening.header.cwd, '/workspace');
    const events = opening.records.map(record => record.event);
    const requestId = randomUUID();
    const prompt = {request: {sessionId: 'native', requestId, mode: 'queue', content: [{type: 'text', text: 'native '}, {type: 'text', text: 'prompt'}], clientTimeZone: 'Asia/Shanghai'}};
    assert.deepEqual(await api.call('session/prompt', prompt), {accepted: true});
    let assistantFrame = false;
    for (;;) {
      const frame = await stream.next();
      if (frame.type === 'assistant-stream') assistantFrame = true;
      if (frame.type === 'event') {
        events.push(frame.event);
        if (frame.event.type === 'turn/end') break;
      }
    }
    assert.equal(assistantFrame, true, 'native assistant presentation frames are forwarded');
    assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index));
    assert.match(JSON.stringify(events.find(event => event.type === 'user/message')), new RegExp(requestId));
    assert.match(JSON.stringify(events.find(event => event.type === 'user/message')), /Asia\/Shanghai/);
    assert.match(JSON.stringify(events.find(event => event.type === 'user/message')), /"text":"native "\},\{"type":"text","text":"prompt"/);
    await stream.close();
    stream = undefined;
    assert.deepEqual(await api.call('session/prompt', prompt), {accepted: true}, 'retry deduplicates the durable prompt');
    const renamed = await api.call<{title: string; seq: number}>('session/rename', {request: {sessionId: 'native', title: '我的工作区'}});
    assert.equal(renamed.title, '我的工作区');
    assert.equal((await api.raw('session/rename', {request: {sessionId: 'native', title: '  '}})).result.error?.code, 'session/title-invalid');
    const page = await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: 'native'}, throughSeq: renamed.seq}});
    const prompts = page.records.filter(record => record.event.type === 'user/message' && JSON.stringify(record.event.data).includes(requestId));
    assert.equal(prompts.length, 1, JSON.stringify(prompts));
    assert.equal(page.records.at(-1)?.event.type, 'session/title');
    assert.match(JSON.stringify(page.records.at(-1)), /我的工作区/);
    assert.equal(page.hasMore, false);
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items[0]!.blank, false);
    const another = await api.call<SessionCreateValue>('session/create', {request: {sessionId: 'native'}});
    assert.notEqual(another.sessionId, 'native', 'a used Session cannot be reused as a new conversation');
    await runtime.dispose();
    runtime = createRuntime(directory, {browser: true});
    stream = await api.follow('native');
    const restored = await stream.next();
    assert.equal(restored.type, 'snapshot');
    if (restored.type !== 'snapshot') throw new Error('Missing restored snapshot');
    assert.deepEqual(restored.records, page.records);
    assert.equal(restored.cursor, renamed.seq);
    assert.match(JSON.stringify(restored.projections.values), /我的工作区/);
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items.length, 2);
  } finally {
    await stream?.close();
    await runtime.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});

test('native Remote rejects invalid contracts and unavailable capabilities without inventing successful results, and keeps environments isolated', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = client(() => runtime);
  try {
    assert.equal((await api.raw('session/create', {request: {sessionId: '../escape'}})).result.error?.code, 'gateway/bad-request');
    assert.equal((await api.raw('session/create', {request: {}}, 'session/list')).result.error?.code, 'gateway/bad-request');
    assert.equal((await api.raw('session/create', {request: {cwd: '/etc'}})).result.error?.code, 'gateway/method-unavailable');
    assert.equal((await api.raw('session/modelCatalog', {})).result.error?.code, 'gateway/method-unavailable');
    await api.call('session/create', {request: {sessionId: 'same'}});
    const error = await api.raw('session/page', {request: {address: {kind: 'session', sessionId: 'same'}, throughSeq: 999}});
    assert.equal(error.result.error?.code, 'gateway/bad-request');
    assert.equal((await api.raw('session/prompt', {request: {sessionId: 'same', requestId: randomUUID(), mode: 'steer', content: [{type: 'text', text: 'steer'}]}})).result.error?.code, 'session/agent-busy');
    assert.equal((await api.raw('session/prompt', {request: {sessionId: 'same', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'hello'}], clientTimeZone: 'Invalid/Zone'}})).result.error?.code, 'session/invalid-time-zone');
    for (const environment of ['one', 'two']) {
      const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: environment, name: environment}),
      });
      assert.equal(response.status, 201);
    }
    const one = client(() => runtime, 'one'), two = client(() => runtime, 'two');
    await one.call('session/create', {request: {sessionId: 'same'}});
    assert.deepEqual(await two.call('session/list', {_request: {}}), {items: []});
    await two.call('session/create', {request: {sessionId: 'same'}});
    await one.call('session/rename', {request: {sessionId: 'same', title: 'environment one'}});
    const first = await one.follow('same'), second = await two.follow('same');
    try {
      assert.match(JSON.stringify(await first.next()), /environment one/);
      assert.doesNotMatch(JSON.stringify(await second.next()), /environment one/);
    } finally { await first.close(); await second.close(); }
  } finally { await runtime.dispose(); }
});

test('a native follow reconnect sees the actual active Session and assistant snapshot, and closing observers does not cancel model execution', {timeout: 60_000}, async () => {
  const encode = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  const prefix = encode('message_start', {message: {usage: {input_tokens: 12, output_tokens: 0}}})
    + encode('content_block_start', {index: 0, content_block: {type: 'text', text: ''}})
    + encode('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'still running'}});
  const suffix = encode('content_block_stop', {index: 0})
    + encode('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 9}})
    + encode('message_stop', {});
  let finish: (() => void) | undefined;
  const runtime = createRuntime(undefined, {browser: true, bindings: {
    MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-fixture-key', DEEPSEEK_BASE_URL: 'https://model.test/anthropic',
  }, outbound: async () => new Response(new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(new TextEncoder().encode(prefix));
    finish = () => { controller.enqueue(new TextEncoder().encode(suffix)); controller.close(); };
  }}), {headers: {'content-type': 'text/event-stream'}})});
  const api = client(() => runtime);
  const streams: Awaited<ReturnType<typeof api.follow>>[] = [];
  try {
    await api.call('session/create', {request: {sessionId: 'live'}});
    const first = await api.follow('live'); streams.push(first);
    await first.next();
    await api.call('session/prompt', {request: {sessionId: 'live', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'take your time'}]}});
    let cursor = -1;
    for (;;) {
      const frame = await first.next();
      if (frame.type === 'event') cursor = frame.event.seq;
      if (frame.type === 'assistant-stream' && JSON.stringify(frame).includes('still running')) break;
    }
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items[0]!.running, true);
    const second = await api.follow('live'); streams.push(second);
    const opening = await second.next();
    assert.equal(opening.type, 'snapshot');
    if (opening.type !== 'snapshot') throw new Error('Missing live reconnect snapshot');
    assert.equal(opening.cursor, cursor, 'an active read must not synthesize interrupted-turn closers');
    assert.ok(!opening.records.some(record => record.event.type === 'turn/end'));
    assert.match(JSON.stringify(opening.assistantStream?.activeAttempt), /still running/);
    const renamed = await api.call<{title: string; seq: number}>('session/rename', {request: {sessionId: 'live', title: 'renamed while running'}});
    assert.equal(renamed.title, 'renamed while running', 'a title edit does not wait behind the model turn');
    assert.equal((await api.raw('session/prompt', {request: {sessionId: 'live', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'not admitted'}]}})).result.error?.code, 'session/agent-busy');
    const page = await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: 'live'}, throughSeq: cursor}});
    assert.ok(!page.records.some(record => record.event.type === 'turn/end'));
    await first.close(); streams.splice(streams.indexOf(first), 1);
    await second.close(); streams.splice(streams.indexOf(second), 1);
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items[0]!.running, true, 'observer disconnect owns no turn cancellation');
    const third = await api.follow('live'); streams.push(third);
    await third.next();
    assert.ok(finish);
    finish(); finish = undefined;
    for (;;) {
      const frame = await third.next();
      if (frame.type === 'event' && frame.event.type === 'turn/end') {
        assert.match(JSON.stringify(frame.event.data), /completed/);
        break;
      }
    }
  } finally {
    finish?.();
    await Promise.all(streams.map(stream => stream.close()));
    await runtime.dispose();
  }
});

test('native prompt admission returns a credential failure before acknowledging a turn and remains readable after restart', {timeout: 60_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-admission-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = client(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'unconfigured'}});
    await runtime.dispose();
    runtime = createRuntime(directory, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: ''}});
    const result = await api.raw('session/prompt', {request: {sessionId: 'unconfigured', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'must not be acknowledged'}]}});
    assert.equal(result.result.error?.code, 'session/provider-credentials-unavailable');
    const list = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(list.items[0]!.running, false);
    assert.equal(list.items[0]!.blank, true);
  } finally { await runtime.dispose(); await rm(directory, {recursive: true, force: true}); }
});

test('native cancellation reaches the active Agent and commits its terminal event', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true, bindings: {
    MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-fixture-key', DEEPSEEK_BASE_URL: 'https://model.test/anthropic',
  }, outbound: async () => new Response(new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
  }}), {headers: {'content-type': 'text/event-stream'}})});
  const api = client(() => runtime);
  let stream: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'cancel'}});
    stream = await api.follow('cancel');
    await stream.next();
    await api.call('session/prompt', {request: {sessionId: 'cancel', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'cancel me'}]}});
    assert.deepEqual(await api.call('session/cancel', {request: {sessionId: 'cancel'}}), {accepted: true});
    for (;;) {
      const frame = await stream.next();
      if (frame.type === 'event' && frame.event.type === 'turn/end') {
        assert.deepEqual(frame.event.data, {turn: 1, reason: {kind: 'aborted', reason: {kind: 'user'}}});
        break;
      }
    }
  } finally { await stream?.close(); await runtime.dispose(); }
});
