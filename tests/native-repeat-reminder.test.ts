import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the official repeat-tool reminder runs in native Sessions from the profile', {timeout: 120_000}, async () => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const bodies: string[] = [];
  let calls = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://repeat-model.test') throw new Error(`Unexpected repeat fixture request ${request.url}`);
    const body = await request.text();
    const turn = body.includes('REPEAT_TASK');
    if (turn) bodies.push(body);
    const tool = turn && calls++ < 3;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: `read-${calls}`, name: 'read', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify({file_path: '/workspace/missing.txt'})} : {type: 'text_delta', text: 'REPEAT_DONE'}}) +
      event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'repeat-fixture', DEEPSEEK_BASE_URL: 'https://repeat-model.test/anthropic'}, outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'repeat'}});
    const follow = await api.follow('repeat');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'repeat', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'REPEAT_TASK'}]}});
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await follow.close();
    assert.equal(bodies.length, 4);
    assert.ok(!bodies[2]!.includes('You are repeating the exact same tool call'), 'two identical calls are not a repeat run yet');
    assert.ok(bodies[3]!.includes('You are repeating the exact same tool call'), 'the third identical call brings the official reminder into the next request');
  } finally {
    await runtime.dispose();
  }
});
