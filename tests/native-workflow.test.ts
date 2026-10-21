import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

const SCRIPT = `phase('Ask');
log('starting with ' + args.n);
const answer = await agent('CHILD_TASK: reply with the child answer', {label: 'child'});
const missing = await Promise.resolve(typeof require);
return {answer, doubled: args.n * 2, missing};`;

/** The parent calls the official workflow tool once; the spawned child answers in text. */
function workflowModel() {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const reply = (block: object, delta: object, stop: string) => new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: block}) + event('content_block_delta', {index: 0, delta}) +
    event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: stop}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}},
  );
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://workflow-model.test') throw new Error(`Unexpected workflow fixture outbound request ${request.url}`);
    const body = JSON.stringify(await request.json());
    if (!body.includes('WORKFLOW_PARENT')) return reply({type: 'text', text: ''}, {type: 'text_delta', text: body.includes('CHILD_TASK') ? 'CHILD_ANSWER' : 'Title'}, 'end_turn');
    if (body.includes('tool_result')) return reply({type: 'text', text: ''}, {type: 'text_delta', text: 'WORKFLOW_DONE'}, 'end_turn');
    const input = {script: SCRIPT, meta: {name: 'ask-child', description: 'Ask one child', phases: [{title: 'Ask'}]}, args: {n: 21}};
    return reply({type: 'tool_use', id: 'workflow-1', name: 'workflow', input: {}}, {type: 'input_json_delta', partial_json: JSON.stringify(input)}, 'tool_use');
  };
  return {outbound};
}

test('the official workflow engine runs scripts and spawns children through the Dynamic Worker PTC runtime', {timeout: 180_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'workflow-fixture', DEEPSEEK_BASE_URL: 'https://workflow-model.test/anthropic'}, outbound: workflowModel().outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'workflow'}});
    const follow = await api.follow('workflow');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'workflow', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'WORKFLOW_PARENT'}]}});
    const events: {type: string; data?: unknown}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; events.push(frame.event); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    const result = JSON.stringify(events.filter(event => event.type === 'tool/result'));
    assert.match(result, /CHILD_ANSWER/, result);
    assert.match(result, /doubled[^0-9]*42/);
    assert.match(result, /missing[^a-z]*undefined/);
    assert.ok(events.some(event => event.type.startsWith('tool-workflow/')), 'the official workflow records its run');
  } finally {
    await runtime.dispose();
  }
});
