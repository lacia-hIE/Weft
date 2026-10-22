import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-settings/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** The model calls each listed tool of the latest turn once; only model HTTP is scripted. */
function toolModel(turns: Record<string, {name: string; input: Record<string, unknown>}[]>) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const used: Record<string, number> = {};
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://runtime-model.test') throw new Error(`Unexpected runtime fixture request ${request.url}`);
    const body = await request.text();
    const payload = JSON.parse(body) as {messages: unknown};
    assert.match(JSON.stringify(payload.messages), /Workspace runtime:/, 'all modes receive the actual workspace execution and persistence contract');
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

test('the workspace runtime is the agent\'s choice under auto, never the container under worker only, and always the container when forced', {timeout: 240_000}, async () => {
  const calls = {
    RUNTIME_AUTO: [{name: 'bash', input: {command: 'echo worker-ran', description: 'Run in the worker shell'}}],
    RUNTIME_SWITCH: [{name: 'workspace_runtime', input: {target: 'container'}}, {name: 'bash', input: {command: 'echo container-ran', description: 'Run in the container'}}],
    RUNTIME_DENY: [{name: 'grep', input: {pattern: 'weft'}}, {name: 'workspace_runtime', input: {target: 'container'}}, {name: 'bash', input: {command: 'echo worker-again', description: 'Run in the worker shell'}}],
    RUNTIME_FORCED: [{name: 'bash', input: {command: 'echo container-ran', description: 'Run in the container'}}, {name: 'grep', input: {pattern: 'weft'}}],
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'runtime-fixture', DEEPSEEK_BASE_URL: 'https://runtime-model.test/anthropic'}, outbound: toolModel(calls)});
  const api = nativeClient(() => runtime);
  try {
    const row = async () => (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(ns => ns.ns === 'workspace-runtime')!;
    assert.deepEqual((await row()).value, {shell: 'auto', containerInstance: 'basic'});
    const setShell = async (shell: string) => api.call('settings/update', {ns: 'workspace-runtime', patch: {shell}, expectedRevision: (await row()).revision});
    await api.call('session/create', {request: {sessionId: 'runtime'}});
    const follow = await api.follow('runtime');
    assert.equal((await follow.next()).type, 'snapshot');
    const turn = async (text: string) => {
      const results: string[] = [];
      await api.call('session/prompt', {request: {sessionId: 'runtime', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      for (;;) {
        const frame: SessionFollowFrame = await follow.next();
        if (frame.type !== 'event') continue;
        if (frame.event.type === 'tool/result') results.push(JSON.stringify(frame.event));
        if (frame.event.type === 'turn/end') return results;
      }
    };
    const deliverable = (route: string) => runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/native/api/${route}`));

    // Auto starts in the worker shell, without change summaries.
    const auto = await turn('RUNTIME_AUTO');
    assert.match(auto[0]!, /worker-ran/);
    assert.equal(await (await deliverable('changes.summary?sessionId=runtime&seq=1')).text(), 'Native Fetch route not found');
    assert.deepEqual(await (await deliverable('present.host')).json(), {name: 'Cloudflare', available: false, fileManager: null});

    // The agent switches to the container, and the next command goes there.
    const switched = await turn('RUNTIME_SWITCH');
    assert.match(switched[0]!, /Commands now run in the container/);
    assert.match(switched[1]!, /no workspace container/, 'a deployment without containers says so instead of running elsewhere');

    // Worker only forbids the container: file search cannot start ripgrep, the switch is gone, and commands stay in the worker.
    await setShell('worker');
    const denied = await turn('RUNTIME_DENY');
    // The official file search reports the refused ripgrep as its own provider failure.
    assert.match(denied[0]!, /ripgrep provider failure[\s\S]*SEARCH_FAILED/);
    assert.doesNotMatch(denied[1]!, /Commands now run/, 'the switch tool is not offered');
    assert.match(denied[2]!, /worker-again/);

    // Always container: every command and the change recorder use it.
    await setShell('container');
    const forced = await turn('RUNTIME_FORCED');
    assert.match(forced[0]!, /no workspace container/);
    // The official file search reports a ripgrep that could not start as its own provider failure.
    assert.match(forced[1]!, /ripgrep provider failure[\s\S]*SEARCH_FAILED/, 'file search runs ripgrep in the container, which this deployment lacks');
    const summary = await deliverable('changes.summary?sessionId=runtime&seq=1');
    assert.equal(summary.status, 404);
    assert.equal(await summary.text(), 'Change summary unavailable.');
    assert.equal((await deliverable('changes.open?sessionId=runtime&seq=1&index=0')).status, 409);
    await follow.close();
  } finally {
    await runtime.dispose();
  }
});

test('container controls are environment-scoped, do not activate Sessions, and preserve files when containers are unavailable', {timeout: 60_000}, async () => {
  const runtime = createRuntime();
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const endpoint = base + '/native/workspace-container';
  try {
    await api.call('session/create', {request: {sessionId: 'cold'}});
    const written = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: 'kept.txt', content: 'keep this', expectedVersion: null})});
    assert.equal(written.status, 200);
    const state = await runtime.dispatchFetch(url('alpha', endpoint));
    assert.equal(state.status, 200);
    assert.equal(state.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await state.json(), {available: false, status: 'stopped'});
    const stop = await runtime.dispatchFetch(url('alpha', endpoint), {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
    assert.equal(stop.status, 501);
    assert.equal((await stop.json() as {code: string}).code, 'CONTAINER_UNAVAILABLE');
    const listed = await api.call<{items: {agentAvailable: boolean}[]}>('session/list', {_request: {}});
    assert.equal(listed.items[0]!.agentAvailable, false, 'read and stop never start a cold Agent');
    const file = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files?path=kept.txt'));
    assert.equal(file.status, 200);
    assert.match(await file.text(), /keep this/);
    const foreign = await runtime.dispatchFetch(url('beta', endpoint));
    assert.equal(foreign.status, 403);
    const csrf = await runtime.dispatchFetch(url('alpha', endpoint), {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://another.example'}, body: '{}'});
    assert.equal(csrf.status, 403);
    const invalid = await runtime.dispatchFetch(url('alpha', endpoint), {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"workspaceId":"foreign"}'});
    assert.equal(invalid.status, 400);
  } finally {await runtime.dispose();}
});
