import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Response} from 'miniflare';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativePluginModel, nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import type {PluginInventorySnapshot} from '@deepseek-ai/dsh-host-plugin-inventory/types';
import type {PluginInfo, BundleInfo, ChangeResult} from '@deepseek-ai/dsh-plugin-manager/types';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {AgentRevision} from '../packages/control-plane/src/contracts.ts';

test('inventory covers the pinned official profile and durable management retires presets without changing frozen sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-manager-'));
  const provider = nativePluginModel();
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'manager-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: provider.outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    const inventory = await api.call<PluginInventorySnapshot>('pluginInventory/list', {});
    assert.equal(inventory.managementAvailable, true);
    const profile = await import('../.generated/official-profile.mjs');
    const expected: string[] = [];
    profile.walkEntries(profile.officialProfile, row => {if (!row.group) expected.push(row.id);});
    const presets = inventory.entries.filter(row => row.moduleName === 'cordis:agent-preset');
    assert.deepEqual(presets.map(row => row.entryId).sort(), ['preset-cordis', 'preset-minimal', 'preset-ptc', 'preset-standard']);
    const globals = inventory.entries.filter(row => row.moduleName !== 'cordis:agent-preset');
    assert.deepEqual(globals.map(row => row.entryId).sort(), expected.sort());
    assert.equal(new Set(inventory.entries.map(row => row.entryId)).size, inventory.entries.length);
    assert.ok(globals.every(row => row.fiberPhase === null), 'deployment inventory does not invent live Session fiber states');
    const description = (id: string) => JSON.stringify(globals.find(row => row.entryId === id)?.meta?.description);
    assert.match(description('subprocess'), /Platform replacement/);
    assert.match(description('mcp-resources'), /Not implemented/);
    assert.match(description('office-to-pdf'), /Not connected/);
    assert.match(description('tool-bash'), /Agent presets/);
    assert.match(description('agent-loop'), /Mounted by Weft/);
    assert.equal(globals.find(row => row.entryId === 'ui-settings-account')?.enabled, false);
    assert.equal(globals.find(row => row.moduleName === '@deepseek-ai/dsh-client-ui-settings-plugin-inventory')?.enabled, true);
    assert.ok(inventory.entries.filter(row => row.entryId === 'preset-standard' || row.entryId === 'preset-cordis').every(row => row.fiberPhase === 'active'));
    assert.equal(inventory.agentPresets?.find(row => row.id === 'cordis')?.rows.find(row => row.entryId === 'tool-todo')?.fiberPhase, 'active');
    const bundles = await api.call<BundleInfo[]>('pluginManager/listBundles', {});
    assert.deepEqual(bundles.map(bundle => bundle.name), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@weft/harness-profile', '@deepseek-ai/dsh-experimental-agent-team-profile']);
    assert.equal(bundles.find(bundle => bundle.name === '@weft/harness-profile')?.rows.length, 4);
    assert.deepEqual(bundles.filter(bundle => bundle.installed).flatMap(bundle => bundle.rows.map(row => row.rowId)).sort(), inventory.entries.map(row => row.entryId).sort());
    const plugins = await api.call<PluginInfo[]>('pluginManager/listPlugins', {});
    assert.equal(plugins.find(row => row.entryId === 'preset-standard')?.readOnlyReason, 'management-required');
    assert.equal(plugins.find(row => row.entryId === 'llm')?.readOnlyReason, 'management-required');
    assert.equal(plugins.find(row => row.entryId === 'mcp-resources')?.readOnlyReason, 'management-required');
    assert.equal(plugins.find(row => row.entryId === 'llm-retry')?.patchId, 'llm-retry');
    await api.call('session/create', {request: {sessionId: 'retained', agentPreset: 'cordis'}});
    const changes = await api.events();
    assert.equal((await changes.next()).type, 'ready');
    const disabled = await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id: 'preset-cordis', enabled: false});
    assert.equal(disabled.application, 'applied');
    assert.equal(disabled.changed, true);
    const settingsChange = await changes.next();
    assert.equal(settingsChange.type, 'emit');
    if (settingsChange.type === 'emit') assert.equal(settingsChange.event, 'settings/document-updated');
    const change = await changes.next();
    assert.equal(change.type, 'emit');
    if (change.type === 'emit') {assert.equal(change.event, 'plugin-manager/changed'); assert.deepEqual(change.args, [{reason: 'plugin'}]);}
    await changes.close();
    assert.equal((await api.raw('session/create', {request: {agentPreset: 'cordis'}})).result.error?.code, 'agent-preset/not-found');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const restored = await api.call<PluginInventorySnapshot>('pluginInventory/list', {});
    assert.deepEqual(restored.entries.find(row => row.entryId === 'preset-cordis'), {entryId: 'preset-cordis', moduleName: 'cordis:agent-preset', enabled: false, fiberPhase: null, meta: {title: {en: 'Creator mode', zh: '创造模式'}}});
    assert.ok(!restored.agentPresets?.some(row => row.id === 'cordis'));
    await api.call('session/prompt', {request: {sessionId: 'retained', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Create the native counter plugin'}]}});
    await (await runtime.dispatchFetch(url('alpha', base+'/sessions/retained/events'))).json();
    const dynamic = await api.call<{agentId: string; latestRun: {status: string}}[]>('dynamicCordisRunner/inventory', {});
    assert.equal(dynamic[0]?.agentId, 'retained');
    assert.equal(dynamic[0]?.latestRun.status, 'awaiting-approval', 'a retired preset does not remove the frozen Creator tools from existing sessions');
    assert.equal((await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id: 'preset-cordis', enabled: true})).changed, true);
    assert.equal((await api.call<{agentPreset: string}>('session/create', {request: {agentPreset: 'cordis'}})).agentPreset, 'cordis');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('management guards protect the selected default, preserve environment boundaries and report unavailable package installation honestly', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const other = nativeClient(() => runtime, 'other');
  try {
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})})).status, 201);
    assert.equal((await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id: 'preset-standard', enabled: false})).error?.code, 'management-required');
    await api.call('settings/update', {ns: 'agent-preset-registry', patch: {selectedDefault: 'cordis'}, expectedRevision: 0});
    assert.equal((await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id: 'preset-standard', enabled: false})).application, 'applied');
    assert.equal((await api.call<{agentPreset: string}>('session/create', {request: {}})).agentPreset, 'cordis');
    assert.equal((await other.call<PluginInventorySnapshot>('pluginInventory/list', {})).entries.find(row => row.entryId === 'preset-standard')?.enabled, true);
    assert.equal((await api.raw('settings/update', {ns: 'agent-preset-registry', patch: {selectedDefault: 'standard'}})).result.error?.code, 'settings/rejected');
    assert.equal((await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id: 'preset-unknown', enabled: true})).error?.code, 'unknown-plugin');
    for (const id of ['llm', 'mcp-resources', 'office-to-pdf', 'ui-settings-account']) assert.equal((await api.call<ChangeResult>('pluginManager/setPluginEnabled', {id, enabled: true})).error?.code, 'management-required');
    assert.equal((await api.call<ChangeResult>('pluginManager/removeBundle', {name: '@weft/harness-profile'})).error?.code, 'management-required');
    assert.equal((await api.call<ChangeResult>('pluginManager/setBundleEnabled', {name: '@deepseek-ai/dsh-base', enabled: false})).error?.code, 'management-required');
    assert.equal((await api.call<{status: string}>('pluginManager/inspect', {spec: '@some/unsupported-bundle'})).status, 'refused');
    const install = await api.call<ChangeResult>('pluginManager/installBundle', {spec: '@some/unsupported-bundle'});
    assert.equal(install.changed, false); assert.equal(install.application, 'failed');
    assert.equal((await api.raw('pluginManager/setPluginEnabled', {id: 'preset-cordis', enabled: 'yes'})).result.error?.code, 'gateway/bad-request');
  } finally {await runtime.dispose();}
});

test('global policy switches persist per environment, survive restart and change actual commands at the next turn', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-global-plugins-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  const other = nativeClient(() => runtime, 'other');
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const feedback = async (session: string) => (await api.call<{name: string}[]>('commands/list', {agentId: session})).some(row => row.name === 'feedback');
  const turn = async (session: string) => {
    await api.call('session/prompt', {request: {sessionId: session, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Hello'}]}});
    await (await runtime.dispatchFetch(url('alpha', base+`/sessions/${session}/events`))).json();
  };
  const toggle = (id: string, enabled: boolean) => api.call<ChangeResult>('pluginManager/setPluginEnabled', {id, enabled});
  try {
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})})).status, 201);
    await api.call('session/create', {request: {sessionId: 'policy'}});
    assert.equal(await feedback('policy'), true);
    await api.call('settings/openSettingsDocument', {});
    const changes = await Promise.all([toggle('command-feedback', false), toggle('llm-retry', false)]);
    assert.ok(changes.every(row => row.application === 'applied' && row.changed));
    assert.equal((await toggle('llm-retry', false)).changed, false);
    assert.equal(await feedback('policy'), true, 'an existing world stays unchanged until the next turn boundary');
    await turn('policy');
    assert.equal(await feedback('policy'), false, 'the real command registration was disposed');
    await api.call('session/create', {request: {sessionId: 'disabled'}});
    assert.equal(await feedback('disabled'), false, 'new worlds respect saved enablement');
    assert.equal((await other.call<PluginInventorySnapshot>('pluginInventory/list', {})).entries.find(row => row.entryId === 'command-feedback')?.enabled, true);
    const file = await (await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files?path='+encodeURIComponent('/workspace/.dsh/profile.yml')))).json() as {value: {content: string}};
    assert.match(file.value.content, /command-feedback: false/);
    assert.match(file.value.content, /llm-retry: false/);
    assert.equal((await api.raw('settings/update', {ns: 'weft-plugin-enablement', patch: {llm: false}})).result.error?.code, 'settings/rejected');
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    const restored = await api.call<PluginInventorySnapshot>('pluginInventory/list', {});
    for (const id of ['command-feedback', 'llm-retry']) assert.equal(restored.entries.find(row => row.entryId === id)?.enabled, false);
    assert.equal(await feedback('policy'), false);
    assert.equal((await toggle('command-feedback', true)).changed, true);
    await turn('policy');
    assert.equal(await feedback('policy'), true, 're-enabling mounts the original policy in an existing world');
    assert.equal((await api.call<PluginInventorySnapshot>('pluginInventory/list', {})).entries.find(row => row.entryId === 'llm-retry')?.enabled, false, 'independent switches do not overwrite one another');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('concurrent preset publications and default selection preserve CAS and never leave the default disabled', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    await api.call('agentPresets/list', {});
    const profile = await (await runtime.dispatchFetch(url('alpha', base+'/agents/cordis'))).json() as AgentRevision;
    const publish = () => runtime.dispatchFetch(url('alpha', base+'/agents'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({spec: {...profile.spec, disabled: true}, expectedRevision: profile.revision})});
    const [first, second] = await Promise.all([publish(), publish(), api.raw('settings/update', {ns: 'agent-preset-registry', patch: {selectedDefault: 'cordis'}, expectedRevision: 0})]);
    assert.ok([first.status, second.status].every(status => status === 200 || status === 409));
    assert.ok(Number(first.status === 200) + Number(second.status === 200) <= 1);
    const latest = await (await runtime.dispatchFetch(url('alpha', base+'/agents/cordis'))).json() as AgentRevision;
    assert.equal(latest.revision, profile.revision + Number(first.status === 200) + Number(second.status === 200));
    const roster = await api.call<{presets: {id: string; isDefault: boolean}[]}>('agentPresets/list', {});
    assert.equal(roster.presets.filter(row => row.isDefault).length, 1);
    if (latest.spec.disabled) assert.notEqual(roster.presets.find(row => row.isDefault)?.id, 'cordis');
  } finally {await runtime.dispose();}
});

function readPair(step: number): Response {
  const event = (type: string, data: object = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  return new Response(event('message_start', {message: {usage: {input_tokens: 1, output_tokens: 0}}})
    + [0, 1].map(index => event('content_block_start', {index, content_block: {type: 'tool_use', id: 'read-'+step+'-'+index, name: 'read', input: {}}})
      + event('content_block_delta', {index, delta: {type: 'input_json_delta', partial_json: JSON.stringify({file_path: 'probe.txt'})}})
      + event('content_block_stop', {index})).join('')
    + event('message_delta', {delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 2}}) + event('message_stop'), {headers: {'content-type': 'text/event-stream'}});
}

test('original Agent loop settings change actual parallel-safe dispatch on the next step, enforce CAS and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-loop-settings-'));
  let runtime: ReturnType<typeof createRuntime>;
  const api = nativeClient(() => runtime);
  let calls = 0;
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'loop-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: async () => {
    calls++;
    if (calls === 1) await api.call('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 2}, expectedRevision: 1});
    if (calls === 1 || calls === 2 || calls === 4) return readPair(calls);
    return nativeFixtureResponse();
  }};
  runtime = createRuntime(directory, options);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const idle = async () => await (await runtime.dispatchFetch(url('alpha', base+'/sessions/loop/events'))).json() as {events: SessionEvent[]};
  const prompt = () => api.call('session/prompt', {request: {sessionId: 'loop', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Read twice'}]}});
  try {
    const description = await api.call<SettingsDescribeValue>('settings/describe', {});
    const section = description.namespaces.find(row => row.ns === 'agent-loop')!;
    assert.ok(section); assert.ok(!('agents' in (section.value as object)));
    await api.call('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 1}, expectedRevision: 0});
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: '/workspace/probe.txt', content: 'real parallel reads', expectedVersion: null})})).status, 200);
    await api.call('session/create', {request: {sessionId: 'loop'}});
    await prompt();
    const {events} = await idle();
    const tools = events.filter(event => event.type === 'tool/call' || event.type === 'tool/result');
    for (const event of tools) if (event.type === 'tool/result') {
      assert.equal(event.data.message.isError, false, JSON.stringify(event.data));
      assert.match(JSON.stringify(event.data.message.content), /real parallel reads/);
    }
    assert.deepEqual(tools.map(event => event.type), ['tool/call', 'tool/result', 'tool/call', 'tool/result', 'tool/call', 'tool/call', 'tool/result', 'tool/result']);
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal((await api.raw('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 0}})).result.error?.code, 'settings/rejected');
    assert.equal((await api.raw('settings/update', {ns: 'agent-loop', patch: {agents: [{id: 'invalid-factory-entry'}]}})).result.error?.code, 'settings/rejected');
    assert.equal((await api.raw('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 3}, expectedRevision: 1})).result.error?.code, 'settings/conflict');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    await prompt();
    const restored = (await idle()).events.filter(event => event.type === 'tool/call' || event.type === 'tool/result');
    assert.deepEqual(restored.slice(-4).map(event => event.type), ['tool/call', 'tool/call', 'tool/result', 'tool/result']);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
