import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; presets, the confining executor and approvals are the original services. */
function bashModel(calls: Record<string, unknown>[]) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  let index = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://permission-model.test') throw new Error(`Unexpected outbound ${request.url}`);
    await request.json();
    const args = calls[index++];
    const tool = args !== undefined;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: `bash-${index}`, name: 'bash', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify(args)} : {type: 'text_delta', text: 'DONE'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

async function turn(api: ReturnType<typeof nativeClient>, sessionId: string): Promise<string> {
  const follow = await api.follow(sessionId);
  assert.equal((await follow.next()).type, 'snapshot');
  await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'PERMISSION_TASK'}]}});
  const results: unknown[] = [];
  for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; if (frame.event.type === 'tool/result') results.push(frame.event); if (frame.event.type === 'turn/end') break;}
  await follow.close();
  return JSON.stringify(results);
}

test('permission presets bundle the shell sandbox with approvals: read-only refuses writes, escalation asks the client', {timeout: 120_000}, async () => {
  const model = bashModel([
    {command: 'echo blocked > ro.txt', description: 'Write while read-only'},
    {command: 'echo widened > /opt-note.txt && cat /opt-note.txt', description: 'Write outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'The test needs a file outside the workspace.'},
  ]);
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'permission-fixture', DEEPSEEK_BASE_URL: 'https://permission-model.test/anthropic'}, outbound: model.outbound});
  const api = nativeClient(() => runtime);
  const events = await api.stream<RemoteEventDownlinkFrame>('$events', {});
  try {
    const ready = await events.next();
    if (ready.type !== 'ready') throw new Error('Missing ready frame');
    const catalog = await api.call<{options: {value: string}[]; defaultPreset: string}>('permissionPresets/catalog', {});
    assert.deepEqual(catalog.options.map(option => option.value), ['read-only', 'workspace-write', 'danger-full-access']);
    assert.equal(catalog.defaultPreset, 'workspace-write');

    await api.call('session/create', {request: {sessionId: 'perm'}});
    assert.ok((await api.call<{name: string}[]>('commands/list', {agentId: 'perm'})).some(command => command.name === 'permission'));
    const projection = async () => (await api.call<{values: {permissions?: {currentValue: string}}}>('session/projections', {request: {sessionId: 'perm'}})).values.permissions?.currentValue;
    assert.equal(await projection(), 'workspace-write');
    const switched = await api.call<{result: {kind: string}}>('commands/execute', {agentId: 'perm', line: '/permission read-only', submittedAttachments: []});
    assert.equal(switched.result.kind, 'success', JSON.stringify(switched));
    assert.equal(await projection(), 'read-only');

    const answering = (async () => {
      let frame: RemoteEventDownlinkFrame;
      do frame = await events.next(); while (frame.type !== 'waterfall');
      assert.equal(frame.event, 'approval/request');
      await api.call('$events/result', {clientId: ready.clientId, eventId: frame.eventId, outcome: {kind: 'result', value: 'allowed-once'}});
    })();
    const results = await turn(api, 'perm');
    await answering;
    assert.match(results, /blocked by the read-only sandbox/);
    assert.match(results, /widened/, 'the approved escalation ran with full access');
  } finally {
    await events.close();
    await runtime.dispose();
  }
});
