import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; the official tool, service and environment events answer the question. */
function questionModel() {
  const requests: string[] = [];
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://question-model.test') throw new Error('Unexpected question fixture outbound request');
    const body = JSON.stringify(await request.json());
    requests.push(body);
    const tool = !body.includes('tool_result');
    const args = JSON.stringify({questions: [{id: 'color', question: 'Which color?', options: [{label: 'Red'}, {label: 'Blue'}]}]});
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'ask', name: 'ask_user_question', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text: 'ANSWER_SEEN'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound, requests};
}

test('ask_user_question reaches the environment Remote Events client and resumes the native turn with its answer', {timeout: 90_000}, async () => {
  const model = questionModel();
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'question-fixture', DEEPSEEK_BASE_URL: 'https://question-model.test/anthropic'}, outbound: model.outbound});
  const api = nativeClient(() => runtime);
  const events = await api.stream<RemoteEventDownlinkFrame>('$events', {});
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    const ready = await events.next();
    assert.equal(ready.type, 'ready');
    if (ready.type !== 'ready') throw new Error('Missing ready frame');
    await api.call('session/create', {request: {sessionId: 'asking'}});
    follow = await api.follow('asking');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'asking', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'ASK_TASK'}]}});

    let invocation: RemoteEventDownlinkFrame;
    do invocation = await events.next(); while (invocation.type !== 'waterfall');
    assert.equal(invocation.event, 'user-questions/request');
    assert.equal(invocation.agentId, 'asking');
    assert.match(JSON.stringify(invocation.request), /Which color\?/);

    const projections = await api.call<{kind: string; values: Record<string, unknown>}>('session/projections', {request: {sessionId: 'asking'}});
    // A foreground (legacy) question lives in its waterfall; the original projection lists continued calls only.
    assert.deepEqual(projections.values.userQuestions, {active: [], settled: []}, 'the read side folds the original question projection');
    const stale = await api.raw('$events/result', {clientId: crypto.randomUUID(), eventId: invocation.eventId, outcome: {kind: 'next'}});
    assert.equal(stale.result.ok, false, 'a result must name a live event stream');
    await api.call('$events/result', {clientId: ready.clientId, eventId: invocation.eventId, outcome: {kind: 'result', value: {answers: [{id: 'color', selected: ['Blue']}]}}});

    const committed: unknown[] = [];
    for (;;) {
      const frame: SessionFollowFrame = await follow.next();
      if (frame.type !== 'event') continue;
      committed.push(frame.event);
      if (frame.event.type === 'turn/end') break;
    }
    assert.match(JSON.stringify(committed), /selected\\*":\[\\*"Blue/);
    assert.match(JSON.stringify(committed), /ANSWER_SEEN/);
    assert.match(model.requests.at(-1)!, /Blue/, 'the model receives the answered tool result');
    assert.equal(await api.call('userQuestions/answer', {agentId: 'asking', callId: 'ask', answer: {answers: [{id: 'color', selected: ['Red']}]}}), false, 'a settled call is no longer answerable');
  } finally {
    await follow?.close();
    await events.close();
    await runtime.dispose();
  }
});
