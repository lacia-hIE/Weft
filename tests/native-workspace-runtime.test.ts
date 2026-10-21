import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-settings/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** The model calls each listed tool of the latest turn once; only model HTTP is scripted. */
function toolModel(turns: Record<string, {name: string; input: Record<string, unknown>}[]>) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const used: Record<string, number> = {};
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://runtime-model.test') throw new Error(`Unexpected runtime fixture request ${request.url}`);
    const body = await request.text();
    const turn = Object.keys(turns).findLast(marker => body.includes(marker));
    let call: {name: string; input: Record<string, unknown>} | undefined;
    if (turn !== undefined) {
      const index = used[turn] ?? 0;
      used[turn] = index + 1;
      call = turns[turn]![index];
    }
    const id = `${turn}-${used[turn ?? ''] ?? 0}`;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: call ? {type: 'tool_use', id, name: call.name, input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: call ? {type: 'input_json_delta', partial_json: JSON.stringify(call.input)} : {type: 'text_delta', text: 'RUNTIME_DONE'}}) +
      event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return outbound;
}

test('the workspace runtime setting chooses where commands run and file search needs the container', {timeout: 180_000}, async () => {
  const calls = {
    RUNTIME_ONE: [{name: 'bash', input: {command: 'echo worker-ran', description: 'Run in the worker shell'}}],
    RUNTIME_TWO: [{name: 'bash', input: {command: 'echo container-ran', description: 'Run in the container'}}, {name: 'grep', input: {pattern: 'weft'}}],
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'runtime-fixture', DEEPSEEK_BASE_URL: 'https://runtime-model.test/anthropic'}, outbound: toolModel(calls)});
  const api = nativeClient(() => runtime);
  try {
    const row = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(ns => ns.ns === 'workspace-runtime');
    assert.ok(row, 'the environment chooses its workspace runtime in settings');
    assert.deepEqual(row.value, {shell: 'worker', containerInstance: 'basic'});
    await api.call('session/create', {request: {sessionId: 'runtime'}});
    const follow = await api.follow('runtime');
    assert.equal((await follow.next()).type, 'snapshot');
    const results: string[] = [];
    const turn = async (text: string) => {
      await api.call('session/prompt', {request: {sessionId: 'runtime', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      for (;;) {
        const frame: SessionFollowFrame = await follow.next();
        if (frame.type !== 'event') continue;
        if (frame.event.type === 'tool/result') results.push(JSON.stringify(frame.event));
        if (frame.event.type === 'turn/end') break;
      }
    };
    await turn('RUNTIME_ONE');
    // A turn reads the environment's settings before it starts.
    await api.call('settings/update', {ns: 'workspace-runtime', patch: {shell: 'container'}, expectedRevision: row.revision});
    await turn('RUNTIME_TWO');
    await follow.close();
    assert.equal(results.length, 3, results.join('\n'));
    assert.match(results[0]!, /worker-ran/);
    assert.match(results[1]!, /no workspace container/, 'a deployment without containers says so instead of running elsewhere');
    // The official file search reports a ripgrep that could not start as its own provider failure.
    assert.match(results[2]!, /ripgrep provider failure[\s\S]*SEARCH_FAILED/, 'file search runs ripgrep in the container, which this deployment lacks');
  } finally {
    await runtime.dispose();
  }
});
