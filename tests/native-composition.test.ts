import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativePluginModel, nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import type {AgentRevision} from '../packages/control-plane/src/contracts.ts';
import {sessionAddress, type SessionScope} from '../packages/tenant/src/index.ts';

test('official preset roster and declaration views reflect real environment profiles and durable defaults', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    const roster = await api.call<{presets: {id: string; isDefault: boolean; broken?: string}[]}>('agentPresets/list', {});
    assert.deepEqual(roster.presets.map(row => row.id).sort(), ['cordis','default','standard']);
    assert.ok(roster.presets.every(row => row.broken === undefined), JSON.stringify(roster));
    assert.equal(roster.presets.find(row => row.isDefault)?.id, 'default');
    const document = await api.call<{agentPreset: string; content: string}>('agentPresets/read', {agentPreset: 'cordis'});
    assert.equal(document.agentPreset, 'cordis');
    assert.match(document.content, /cordis:tool-skill/);
    assert.match(document.content, /skills: true/);
    await api.call('settings/update', {ns: 'agent-preset-registry', patch: {selectedDefault: 'cordis'}, expectedRevision: 0});
    assert.equal((await api.call<typeof roster>('agentPresets/list', {})).presets.find(row => row.isDefault)?.id, 'cordis');
    const created = await api.call<{sessionId: string; agentPreset: string}>('session/create', {request: {sessionId: 'creator-preset'}});
    assert.equal(created.agentPreset, 'cordis');
    const profile = await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/agents/cordis`))).json() as {spec: {allowClientPlugins: boolean}};
    assert.equal(profile.spec.allowClientPlugins, true);
    assert.equal((await api.raw('settings/update', {ns: 'agent-preset-registry', patch: {selectedDefault: 'missing'}})).result.ok, false);
  } finally {await runtime.dispose();}
});

test('native preset selection keeps creation headers, records exact choices, freezes capabilities and rejects post-turn changes across restart', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-preset-session-'));
  const provider = nativePluginModel();
  const model = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'preset-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: provider.outbound};
  let runtime = createRuntime(directory, model);
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    await api.call('agentPresets/list', {});
    await api.call('session/create', {request: {sessionId: 'chosen-preset'}});
    assert.equal(await api.call('agentPresets/select', {agentId: 'chosen-preset', agentPreset: 'cordis'}), 'cordis');
    const reused = await api.call<{sessionId: string; agentPreset: string}>('session/create', {request: {sessionId: 'chosen-preset', agentPreset: 'standard'}});
    assert.equal(reused.sessionId, 'chosen-preset');
    assert.equal(reused.agentPreset, 'standard');
    assert.equal(await api.call('agentPresets/select', {agentId: 'chosen-preset', agentPreset: 'cordis'}), 'cordis');
    const projections = await api.call<{values: {agentPreset: string}}>('session/projections', {request: {sessionId: 'chosen-preset'}});
    assert.equal(projections.values.agentPreset, 'cordis');
    const stream = await api.follow('chosen-preset');
    const opening = await stream.next();
    await stream.close();
    assert.equal(opening.type, 'snapshot');
    if (opening.type !== 'snapshot') throw new Error('Missing native opening snapshot');
    assert.equal(opening.header.agentPreset, 'default');
    assert.equal(opening.projections.values.agentPreset, 'cordis');
    const original = await (await runtime.dispatchFetch(url('alpha', base+'/agents/cordis'))).json() as AgentRevision;
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/agents'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({spec: {...original.spec, allowClientPlugins: false}, expectedRevision: original.revision})})).status, 200);
    await runtime.dispose(); runtime = createRuntime(directory, model);
    await api.call('session/prompt', {request: {sessionId: 'chosen-preset', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Create the native counter plugin'}]}});
    await (await runtime.dispatchFetch(url('alpha', base+'/sessions/chosen-preset/events'))).json();
    const inventory = await api.call<{agentId: string; latestRun: {status: string}}[]>('dynamicCordisRunner/inventory', {});
    assert.equal(inventory[0]?.agentId, 'chosen-preset', 'the selected frozen Creator revision retains actual authoring tools');
    assert.equal(inventory[0]?.latestRun.status, 'awaiting-approval');
    const locked = await api.raw('agentPresets/select', {agentId: 'chosen-preset', agentPreset: 'standard'});
    assert.equal(locked.result.error?.code, 'agent-preset/locked');
    assert.equal((await api.call<typeof projections>('session/projections', {request: {sessionId: 'chosen-preset'}})).values.agentPreset, 'cordis');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('native Todo wire projections use the original fold in hot reads and after workerd restart', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-preset-todos-'));
  let calls = 0;
  const model = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'todo-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: async () => ++calls === 1 ? nativeFixtureResponse({name: 'todo_write', input: {todos: [{content: 'Native plan', status: 'in_progress'}]}}) : nativeFixtureResponse()};
  let runtime = createRuntime(directory, model);
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'todo-projection'}});
    await api.call('session/prompt', {request: {sessionId: 'todo-projection', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Make a plan'}]}});
    await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/todo-projection/events`))).json();
    const expected = [{content: 'Native plan', status: 'in_progress'}];
    assert.deepEqual((await api.call<{values: {todos: unknown}}>('session/projections', {request: {sessionId: 'todo-projection'}})).values.todos, expected);
    await runtime.dispose(); runtime = createRuntime(directory, model);
    assert.deepEqual((await api.call<{values: {todos: unknown}}>('session/projections', {request: {sessionId: 'todo-projection'}})).values.todos, expected);
    assert.equal(calls, 2, 'cold projection reads must not invoke the model');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('preset recovery promotes only a snapshot whose native selection event committed after preparation', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-preset-gap-'));
  const options = {browser: true, scriptPath: 'dist/preset-worker.js'};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    await api.call('agentPresets/list', {});
    const before = await (await runtime.dispatchFetch(url('alpha', base+'/agents/default'))).text();
    const after = await (await runtime.dispatchFetch(url('alpha', base+'/agents/cordis'))).text();
    for (const sessionId of ['committed', 'uncommitted']) await api.call('session/create', {request: {sessionId}});
    const cut = await api.call<{asOfSeq: number}>('session/projections', {request: {sessionId: 'committed'}});
    await api.call('agentPresets/select', {agentId: 'committed', agentPreset: 'cordis'});
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const namespace = await runtime.getDurableObjectNamespace('SESSIONS', 'alpha');
    for (const sessionId of ['committed', 'uncommitted']) {
      const scope: SessionScope = {tenantId: tenantId('alpha'), environmentId: 'default', sessionId};
      const object = namespace.get(namespace.idFromName(sessionAddress(scope))) as unknown as {stagePresetGap(scope: SessionScope, before: string, after: string, beforeSeq: number): Promise<void>};
      await object.stagePresetGap(scope, before, after, cut.asOfSeq);
    }
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.equal(await api.call('agentPresets/select', {agentId: 'committed', agentPreset: 'cordis'}), 'cordis');
    assert.equal(await api.call('agentPresets/select', {agentId: 'uncommitted', agentPreset: 'default'}), 'default');
    assert.equal((await api.call<{values: {agentPreset: string}}>('session/projections', {request: {sessionId: 'committed'}})).values.agentPreset, 'cordis');
    assert.equal((await api.call<{values: {agentPreset: string}}>('session/projections', {request: {sessionId: 'uncommitted'}})).values.agentPreset, 'default');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('original Loader and AgentPresetRegistry run in workerd with real scoped tools, diagnostics, selection and locks', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-composition-'));
  const options = convertV4MiniflareOptions({modules: true, scriptPath: resolve('dist/composition-worker.js'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjectsPersist: directory, durableObjects: {COMPOSITIONS: {className: 'CompositionBench', useSQLite: true}}});
  options.workers[0]!.dev = {...options.workers[0]!.dev, unsafeRegisterWorker: false};
  let runtime = new Miniflare({...options, resourcePersistencePath: directory});
  const call = async (action: string, preset?: string, owner = 'one') => {
    const response = await runtime.dispatchFetch('http://localhost', {method: 'POST', body: JSON.stringify({action, preset, owner})});
    return {status: response.status, value: await response.json() as any};
  };
  try {
    const roster = await call('roster');
    assert.equal(roster.status, 200, JSON.stringify(roster.value));
    assert.equal(roster.value.presets.find((row: any) => row.id === 'single').isDefault, true);
    assert.match(roster.value.presets.find((row: any) => row.id === 'broken').broken, /prebuilt workerd catalog/);
    assert.match(roster.value.presets.find((row: any) => row.id === 'expression').broken, /configuration expressions/);
    const initial = await call('state');
    assert.equal(initial.value.selected, 'single');
    assert.ok(initial.value.tools.includes('todo_write'));
    assert.ok(!initial.value.rootTools.includes('todo_write'), 'preset tool registrations must not leak into the host');
    assert.ok(initial.value.scopes.every((scope: any) => scope.leakedServices.length === 0));
    assert.equal((await call('todos')).value.isError, true);
    const parallel = await call('select', 'parallel');
    assert.equal(parallel.status, 200, JSON.stringify(parallel.value));
    assert.equal((await call('todos')).value.isError, false);
    assert.equal((await call('select', 'minimal')).status, 200);
    assert.ok(!(await call('state')).value.tools.includes('todo_write'));
    assert.equal((await call('state', undefined, 'other')).value.selected, 'single');
    const document = await call('read', 'parallel');
    assert.match(document.value.content, /allowParallelInProgress: true/);
    assert.equal((await call('select', 'broken')).status, 400);
    assert.equal((await call('prompt')).status, 200);
    const locked = await call('select', 'single');
    assert.equal(locked.status, 400);
    assert.match(locked.value.error, /already started/);
    await runtime.dispose(); runtime = new Miniflare({...options, resourcePersistencePath: directory});
    const restored = await call('state');
    assert.equal(restored.status, 200, JSON.stringify(restored.value));
    assert.equal(restored.value.selected, 'minimal', JSON.stringify(restored.value));
    assert.ok(!restored.value.tools.includes('todo_write'));
    assert.equal((await call('select', 'single')).status, 400, 'a restart cannot unlock a session which already ran');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
