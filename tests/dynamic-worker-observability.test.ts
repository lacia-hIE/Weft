import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {DynamicWorkerUsage} from '../packages/dynamic-worker-observability/src/tail.ts';
import {Response, type V4FetchHandler} from 'miniflare';

test('real Tail events attribute cached Workers, facets, PTC, JavaScript and shell without recording guest payloads', {timeout: 180_000}, async () => {
  let calls = 0;
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://observation-model.test') throw new Error('Unexpected model endpoint');
    const tool = ++calls === 1;
    return new Response(event('message_start', {message: {usage: {input_tokens: 1, output_tokens: 0}}})
      + event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'run', name: 'run_code', input: {}} : {type: 'text', text: ''}})
      + event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify({description: 'Observe a native program', code: 'console.log("PTC_SECRET"); return 42;'})} : {type: 'text_delta', text: 'done'}})
      + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 1}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  };
  const directory = await mkdtemp(join(tmpdir(), 'weft-observations-'));
  const options: Parameters<typeof createRuntime>[1] = {browser: true, scriptPath: 'dist/dynamic-worker-observability.js',
    durableObjects: {USAGE: {className: 'Usage', useSQLite: true}, OBSERVATION_BENCH: {className: 'ObservationBench', useSQLite: true}},
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'observation-fixture', DEEPSEEK_BASE_URL: 'https://observation-model.test/anthropic'}, outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const post = async (path: string, body: unknown) => {
    const response = await runtime.dispatchFetch(url('alpha', path), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const rows = async (): Promise<DynamicWorkerUsage[]> => await (await runtime.dispatchFetch(url('alpha', '/_test/usage'))).json() as DynamicWorkerUsage[];
  const until = async (match: (rows: DynamicWorkerUsage[]) => boolean) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) {
      const values = await rows(); if (match(values)) return values;
    }
    throw new Error('Missing Tail observations: ' + JSON.stringify(await rows()));
  };
  try {
    for (const mode of ['get', 'get', 'load', 'facet'] as const) assert.equal(await post('/_test/observe', {tenantId: 'alice', environmentId: 'work', mode}), 42);
    assert.equal(await post('/_test/observe', {tenantId: 'bob', environmentId: 'personal', mode: 'get'}), 42);
    let values = await until(values => values.filter(row => row.kind === 'plugin').length >= 6 && values.some(row => row.loaderMode === 'load' && row.exceptionCount > 0));
    assert.ok(values.some(row => row.kind === 'plugin' && row.executionModel === 'durableObject'), 'facet calls must reach the collector');
    const cached = values.filter(row => row.tenantId === 'alice' && row.loaderMode === 'get');
    assert.equal(new Set(cached.map(row => row.workerId)).size, 1);
    assert.ok(values.some(row => row.tenantId === 'bob' && row.environmentId === 'personal'));
    assert.ok(values.some(row => row.loaderMode === 'load' && row.exceptionCount > 0));
    assert.doesNotMatch(JSON.stringify(values), /GUEST_SECRET|FACET_SECRET|EXCEPTION_SECRET/);
    await api.call('session/create', {request: {sessionId: 'observe-ptc', agentPreset: 'ptc'}});
    const follow = await api.follow('observe-ptc'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'observe-ptc', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Run a program'}]}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await follow.close();
    const scope = {tenantId: tenantId('alpha'), environmentId: 'default', workspaceId: 'default'};
    const started = await post('/_test/javascript', {scope, operation: {operation: 'start', source: 'export default () => 42', cwd: '/workspace'}}) as {id: string};
    let completed = false;
    for (let i = 0; i < 200; i++) {
      const state = await post('/_test/javascript', {scope, operation: {operation: 'status', id: started.id}}) as {status: string; value?: unknown};
      if (state.status === 'completed') {assert.equal(state.value, 42); completed = true; break;}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(completed, true);
    const shell = await post('/_test/shell', {scope}) as {status: number; output: string};
    assert.equal(shell.status, 200); assert.match(shell.output, /OBSERVED_SHELL/);
    values = await until(values => values.some(row => row.kind === 'ptc') && values.some(row => row.kind === 'workspace-javascript') && values.some(row => row.kind === 'workspace-shell'));
    for (const value of values.filter(row => row.kind !== 'plugin')) {
      assert.equal(value.tenantId, scope.tenantId); assert.equal(value.environmentId, 'default');
      assert.ok(value.cpuTimeMs !== null && value.cpuTimeMs >= 0); assert.ok(value.wallTimeMs !== null && value.wallTimeMs >= 0);
    }
    assert.doesNotMatch(JSON.stringify(values), /PTC_SECRET|observation-fixture/);
    const resourceId = values.find(row => row.kind === 'workspace-javascript')!.resourceId!;
    const pending = await post('/_test/javascript', {scope, operation: {operation: 'start', source: 'export default () => new Promise(resolve => setTimeout(() => resolve(42), 5000))', cwd: '/workspace'}}) as {id: string; status: string};
    assert.equal(pending.status, 'running');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const before = (await rows()).filter(row => row.kind === 'workspace-javascript').length;
    await post('/_test/background', {resourceId});
    const recovered = (await until(rows => rows.filter(row => row.kind === 'workspace-javascript').length > before)).filter(row => row.kind === 'workspace-javascript').at(-1)!;
    assert.equal(recovered.tenantId, scope.tenantId); assert.equal(recovered.environmentId, scope.environmentId); assert.equal(recovered.workspaceId, scope.workspaceId);
    const finished = await post('/_test/javascript', {scope, operation: {operation: 'status', id: pending.id}}) as {status: string; value?: unknown};
    assert.equal(finished.status, 'completed'); assert.equal(finished.value, 42);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
