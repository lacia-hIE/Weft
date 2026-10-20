import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; `/plan`, `exit_plan_mode` and the review waterfall are the original services. */
function planModel() {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://plan-model.test') throw new Error('Unexpected plan fixture outbound request');
    const body = JSON.stringify(await request.json());
    const tool = !body.includes('tool_result');
    const args = JSON.stringify({plan: '# Ship the release\n\n1. Tag the build.'});
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'exit-plan', name: 'exit_plan_mode', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text: 'IMPLEMENTING'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

test('/plan enters plan mode and exit_plan_mode reviews the plan through the environment client', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'plan-fixture', DEEPSEEK_BASE_URL: 'https://plan-model.test/anthropic'}, outbound: planModel().outbound});
  const api = nativeClient(() => runtime);
  const events = await api.stream<RemoteEventDownlinkFrame>('$events', {});
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    const ready = await events.next();
    if (ready.type !== 'ready') throw new Error('Missing ready frame');
    await api.call('session/create', {request: {sessionId: 'planning'}});
    const entered = await api.call<{result: {kind: string}}>('commands/execute', {agentId: 'planning', line: '/plan', submittedAttachments: []});
    assert.equal(entered.result.kind, 'success', JSON.stringify(entered));
    assert.match(JSON.stringify((await api.call<{values: Record<string, unknown>}>('session/projections', {request: {sessionId: 'planning'}})).values.plan), /"active":true/);

    follow = await api.follow('planning');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'planning', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'PLAN_TASK'}]}});
    let review: RemoteEventDownlinkFrame;
    do review = await events.next(); while (review.type !== 'waterfall');
    assert.match(JSON.stringify(review.request), /"kind":"plan-review"/);
    assert.match(JSON.stringify(review.request), /Ship the release/);
    await api.call('$events/result', {clientId: ready.clientId, eventId: review.eventId, outcome: {kind: 'result', value: {answers: [{id: 'plan-review', selected: ['Approve']}]}}});

    const committed: unknown[] = [];
    for (;;) {
      const frame: SessionFollowFrame = await follow.next();
      if (frame.type !== 'event') continue;
      committed.push(frame.event);
      if (frame.event.type === 'turn/end') break;
    }
    assert.match(JSON.stringify(committed), /Plan approved/);
    assert.match(JSON.stringify(committed), /IMPLEMENTING/);
    assert.match(JSON.stringify((await api.call<{values: Record<string, unknown>}>('session/projections', {request: {sessionId: 'planning'}})).values.plan), /"active":false/, 'approval leaves plan mode');
  } finally {
    await follow?.close();
    await events.close();
    await runtime.dispose();
  }
});
