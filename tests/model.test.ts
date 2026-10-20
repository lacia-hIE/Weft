import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import {nativeClient} from './helpers/native.ts';
import { createRuntime, send, tenantId, url, sessionPath, type SessionResponse } from './helpers/miniflare.ts';

const bindings = { MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'secret-platform-key', DEEPSEEK_BASE_URL: 'https://model.test/anthropic' };
function event(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
const start = event('message_start', { message: { usage: { input_tokens: 12, output_tokens: 0 } } });
function ending(reason = 'end_turn'): string {
  return event('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 9 } }) + event('message_stop');
}
const textPrefix = start + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好，来自真实协议适配器' } });
const textSuffix = event('content_block_stop', { index: 0 }) + ending();
const tool = start + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_identity', name: 'tenant_identity', input: {} } })
  + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{' } })
  + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '}' } })
  + event('content_block_stop', { index: 0 }) + ending('tool_use');

function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(': keep-alive\n\n' + text);
  // Deliberately split framing, JSON and multi-byte characters across transport chunks.
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function sseFrames(text: string): { event: string; data: Record<string, unknown> }[] {
  return text.trim().split('\n\n').map(frame => {
    const lines = frame.split('\n');
    return { event: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)) as Record<string, unknown> };
  });
}
async function readEvents(runtime: ReturnType<typeof createRuntime>, session: string): Promise<SessionResponse> {
  const response = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', session, 'events')));
  assert.equal(response.status, 200);
  return await response.json() as SessionResponse;
}

test('upstream DeepSeek adapter parses fragmented SSE and drives a real tool round trip', async () => {
  const calls: Record<string, unknown>[] = [];
  const userIds = new Set<string | null>();
  const runtime = createRuntime(undefined, { bindings, outbound: async request => {
    assert.equal(request.url, 'https://model.test/anthropic/v1/messages');
    assert.equal(request.headers.get('x-api-key'), bindings.DEEPSEEK_API_KEY);
    // The environment's random harness-home id, never derived from tenant or user identity.
    assert.match(request.headers.get('x-deepseek-harness-user-id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    userIds.add(request.headers.get('x-deepseek-harness-user-id'));
    assert.equal(request.headers.get('x-deepseek-harness-session-id'), 'provider');
    assert.ok(!JSON.stringify([...request.headers]).includes('alpha@example.com'));
    const body = await request.json() as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.equal(body.model, 'deepseek-flash');
    calls.push(body);
    return streamResponse(calls.length === 1 ? tool : textPrefix + textSuffix);
  } });
  try {
    const response = await send(runtime, 'alpha', 'provider', '调用工具');
    assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text();
    assert.ok(!raw.includes(bindings.DEEPSEEK_API_KEY));
    const result = JSON.parse(raw) as SessionResponse & { model: unknown };
    assert.deepEqual(result.model, { provider: 'deepseek-official', model: 'deepseek-flash' });
    assert.equal(calls.length, 2);
    assert.match(JSON.stringify(calls[1]), /tool_result/);
    assert.match(JSON.stringify(calls[1]), new RegExp(tenantId('alpha')));
    assert.equal(result.events.filter(entry => entry.type === 'tool/call').length, 1);
    assert.match(JSON.stringify(result.events), /你好，来自真实协议适配器/);
    assert.equal(result.events.at(-1)?.data.reason?.kind, 'completed');
    assert.deepEqual((await readEvents(runtime, 'provider')).events, result.events);
    assert.equal((await send(runtime, 'alpha', 'provider', '继续')).status, 200);
    assert.match(JSON.stringify(calls[2]), /你好，来自真实协议适配器/);
    assert.equal(userIds.size, 1, 'one environment sends one anonymous id');
  } finally { await runtime.dispose(); }
});

test('SSE publishes assistant deltas before the model response finishes, then durable completion', async () => {
  let finish!: () => void;
  const runtime = createRuntime(undefined, { bindings, outbound: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(textPrefix));
      finish = () => { controller.enqueue(new TextEncoder().encode(textSuffix)); controller.close(); };
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'stream', 'messages')), {
      method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'stream' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('text-delta')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      text += decoder.decode(next.value, { stream: true });
    }
    assert.ok(!text.includes('event: done'));
    finish();
    for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); }
    const frames = sseFrames(text);
    assert.equal(frames[0]?.event, 'session');
    assert.equal(frames.at(-1)?.event, 'done');
    assert.ok(frames.some(frame => frame.event === 'session-event' && frame.data.type === 'turn/end'));
    assert.ok(frames.some(frame => frame.event === 'assistant-stream' && frame.data.type === 'chunk'));
    assert.equal((await readEvents(runtime, 'stream')).events.at(-1)?.data.reason?.kind, 'completed');
  } finally { await runtime.dispose(); }
});

test('provider failures are classified without persisting or returning echoed credentials', async () => {
  for (const [status, code, expectedStatus] of [[401, 'AUTH', 502], [429, 'RATE_LIMIT', 429], [503, 'SERVER', 502]] as const) {
    let count = 0;
    const runtime = createRuntime(undefined, { bindings, outbound: async () => {
      count++;
      return Response.json({ error: { message: `echo ${bindings.DEEPSEEK_API_KEY}` } }, { status });
    } });
    try {
      const response = await send(runtime, 'alpha', 'failure', 'fail');
      assert.equal(response.status, expectedStatus, await response.clone().text());
      const raw = await response.text();
      assert.equal((JSON.parse(raw) as { code: string }).code, code);
      assert.ok(!raw.includes(bindings.DEEPSEEK_API_KEY));
      const events = await readEvents(runtime, 'failure');
      assert.equal(events.events.at(-1)?.data.reason?.kind, 'error');
      assert.ok(!JSON.stringify(events).includes(bindings.DEEPSEEK_API_KEY));
      assert.equal(count, 1, 'no implicit retry of failed provider requests');
    } finally { await runtime.dispose(); }
  }
});

test('truncated or malformed provider streams fail and preserve a readable session', async () => {
  for (const [payload, code] of [[textPrefix, 'STREAM_CLOSED'], ['event: message_start\ndata: {broken}\n\n', 'MALFORMED_RESPONSE']] as const) {
    const runtime = createRuntime(undefined, { bindings, outbound: async () => streamResponse(payload) });
    try {
      const response = await send(runtime, 'alpha', 'broken', 'fail');
      assert.equal(response.status, 502, await response.clone().text());
      const body = await response.json() as { code: string };
      assert.equal(body.code, code);
      assert.equal((await readEvents(runtime, 'broken')).events.at(-1)?.data.reason?.kind, 'error');
    } finally { await runtime.dispose(); }
  }
});

test('user model settings are exclusive and never fall back across users', async () => {
  const keys: string[] = [];
  const runtime = createRuntime(undefined, { bindings: { ...bindings, TENANT_MODEL_CONFIG_JSON: JSON.stringify({
    [tenantId('alpha')]: { apiKey: 'alpha-private-model-key', model: 'tenant-custom-model' },
  }) }, outbound: async request => {
    keys.push(request.headers.get('x-api-key')!);
    assert.equal((await request.json() as { model: string }).model, 'tenant-custom-model');
    return streamResponse(textPrefix + textSuffix);
  } });
  try {
    assert.equal((await send(runtime, 'alpha', 'keys', 'hello')).status, 200);
    const beta = await send(runtime, 'beta', 'keys', 'hello');
    assert.equal(beta.status, 503);
    assert.equal((await beta.json() as { code: string }).code, 'MODEL_NOT_CONFIGURED');
    assert.deepEqual(keys, ['alpha-private-model-key']);
  } finally { await runtime.dispose(); }
});

test('production ignores server model variables and missing user credentials fail before creating session history', async () => {
  for (const overrides of [{ DEEPSEEK_API_KEY: '' }, { DEEPSEEK_BASE_URL: 'http://insecure.test' }, { TENANT_MODEL_CONFIG_JSON: '{broken' }]) {
    let count = 0;
    const runtime = createRuntime(undefined, { configureModel: false, scriptPath: 'dist/worker.js', bindings: { ...bindings, ...overrides }, outbound: async () => { count++; return streamResponse(textPrefix + textSuffix); } });
    try {
      assert.equal((await send(runtime, 'alpha', 'unconfigured', 'hello')).status, 503);
      assert.equal((await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'unconfigured', 'events')))).status, 404);
      assert.equal(count, 0);
    } finally { await runtime.dispose(); }
  }
});

function stalled(): V4FetchHandler {
  return async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(textPrefix)); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('idle timeout and whole-turn deadline release the session queue', async () => {
  for (const [overrides, code] of [[{ MODEL_IDLE_TIMEOUT_MS: '50' }, 'TIMEOUT'], [{ MODEL_IDLE_TIMEOUT_MS: '60000', MODEL_TURN_TIMEOUT_MS: '100' }, 'TURN_TIMEOUT']] as const) {
    let count = 0;
    const hang = stalled();
    const runtime = createRuntime(undefined, { bindings: { ...bindings, ...overrides }, outbound: async (request, miniflare) => ++count === 1 ? hang(request, miniflare) : streamResponse(textPrefix + textSuffix) });
    try {
      const response = await send(runtime, 'alpha', 'timeout', 'hang');
      assert.equal(response.status, 504, await response.clone().text());
      assert.equal((await response.json() as { code: string }).code, code);
      assert.equal((await send(runtime, 'alpha', 'timeout', 'continue')).status, 200);
    } finally { await runtime.dispose(); }
  }
});

test('request cancellation bypasses the queue, respects tenant boundaries and permits resume', async () => {
  const requested = Promise.withResolvers<void>();
  let count = 0;
  const hang = stalled();
  const runtime = createRuntime(undefined, { bindings, outbound: async (request, miniflare) => {
    if (++count === 1) { requested.resolve(); return hang(request, miniflare); }
    return streamResponse(textPrefix + textSuffix);
  } });
  try {
    const requestId = randomUUID();
    const pending = runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'cancel', 'messages')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hang', requestId }),
    });
    await requested.promise;
    const cancel = (caller: string, id: string) => runtime.dispatchFetch(url(caller, sessionPath('alpha', 'cancel', 'cancel')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id }),
    });
    assert.equal((await cancel('beta', requestId)).status, 403);
    assert.equal((await (await cancel('alpha', randomUUID())).json() as { cancelled: boolean }).cancelled, false);
    const stopped = await cancel('alpha', requestId);
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json() as { cancelled: boolean }).cancelled, true);
    const response = await pending;
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json() as { code: string }).code, 'TURN_CANCELLED');
    assert.equal((await readEvents(runtime, 'cancel')).events.at(-1)?.data.reason?.kind, 'aborted');
    assert.equal((await send(runtime, 'alpha', 'cancel', 'continue')).status, 200);
  } finally { await runtime.dispose(); }
});

test('provider redirects are refused without forwarding credentials to another host', async () => {
  const targets: string[] = [];
  const runtime = createRuntime(undefined, { bindings, outbound: async request => {
    targets.push(request.url);
    return new Response('', { status: 302, headers: { location: 'https://untrusted.example/steal-key' } });
  } });
  try {
    const response = await send(runtime, 'alpha', 'redirect', 'hello');
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { code: string }).code, 'TRANSPORT');
    assert.deepEqual(targets, ['https://model.test/anthropic/v1/messages']);
  } finally { await runtime.dispose(); }
});

test('SSE errors close the stream and leave the failed turn readable', async () => {
  const runtime = createRuntime(undefined, { bindings, outbound: async () => streamResponse('event: message_start\ndata: invalid\n\n') });
  try {
    const response = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'stream-error', 'messages')), {
      method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 200);
    const frames = sseFrames(await response.text());
    assert.equal(frames.at(-1)?.event, 'error');
    assert.equal(frames.at(-1)?.data.code, 'MALFORMED_RESPONSE');
    assert.equal((await readEvents(runtime, 'stream-error')).events.at(-1)?.data.reason?.kind, 'error');
  } finally { await runtime.dispose(); }
});

test('cancelling queued work and rejecting a duplicate ID do not cancel the active turn', async () => {
  const requested = Promise.withResolvers<void>();
  const hang = stalled();
  const runtime = createRuntime(undefined, { bindings, outbound: async (request, miniflare) => { requested.resolve(); return hang(request, miniflare); } });
  try {
    const activeId = randomUUID(), queuedId = randomUUID();
    const post = (requestId: string, text: string) => runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'queue-cancel', 'messages')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, requestId }),
    });
    const cancel = (requestId: string) => runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'queue-cancel', 'cancel')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }),
    });
    const active = post(activeId, 'active');
    await requested.promise;
    assert.equal((await post(activeId, 'duplicate')).status, 409);
    const queued = post(queuedId, 'queued input must never be admitted');
    // Requests traverse the same entry Worker; wait for queue registration using the scoped cancel API.
    let cancelled = false;
    for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
      cancelled = (await (await cancel(queuedId)).json() as { cancelled: boolean }).cancelled;
    }
    assert.equal(cancelled, true);
    assert.equal((await (await cancel(activeId)).json() as { cancelled: boolean }).cancelled, true);
    assert.equal((await active).status, 409);
    assert.equal((await queued).status, 409);
    const history = JSON.stringify(await readEvents(runtime, 'queue-cancel'));
    assert.ok(!history.includes('queued input must never be admitted'));
    assert.ok(!history.includes('duplicate'));
  } finally { await runtime.dispose(); }
});

test('a disconnected SSE consumer cannot hold the session queue beyond its deadline', async () => {
  let count = 0;
  const hang = stalled();
  const runtime = createRuntime(undefined, { bindings: { ...bindings, MODEL_IDLE_TIMEOUT_MS: '250' }, outbound: async (request, miniflare) => ++count === 1 ? hang(request, miniflare) : streamResponse(textPrefix + textSuffix) });
  try {
    await nativeClient(() => runtime).call('settings/describe', {});
    const controller = new AbortController();
    const endpoint = new URL(sessionPath('alpha', 'disconnect', 'messages'), await runtime.ready);
    const response = await fetch(endpoint, {
      method: 'POST', headers: { host: 'alpha.local', accept: 'text/event-stream', 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ text: 'hello' }),
    });
    const reader = response.body!.getReader();
    let received = '';
    while (!received.includes('text-delta')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      received += new TextDecoder().decode(next.value);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    const next = await send(runtime, 'alpha', 'disconnect', 'continue');
    assert.equal(next.status, 200, await next.clone().text());
    const events = (await next.json() as SessionResponse).events;
    const endings = events.filter(entry => entry.type === 'turn/end');
    assert.ok(['aborted', 'error'].includes(endings[0]!.data.reason!.kind));
    assert.equal(endings[1]?.data.reason?.kind, 'completed');
    if (endings[0]!.data.reason!.kind === 'error') assert.match(JSON.stringify(endings[0]), /TIMEOUT/);
  } finally { await runtime.dispose(); }
});
