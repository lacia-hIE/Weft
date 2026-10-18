import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';
import type { AgentRevision } from '../packages/control-plane/src/contracts.ts';
import { nativePluginModel, clientCode } from './helpers/native-plugin-model.ts';
import { nativeHostExample, nativeClientExample } from '../packages/native-plugins/src/guide.ts';

test('model-authored native packages persist, require exact approval, run scoped facet handlers and survive workerd restart', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-native-plugins-'));
  const provider = nativePluginModel();
  const model = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-plugin-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: provider.outbound};
  let runtime = createRuntime(directory, model);
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const idle = async () => {const r = await runtime.dispatchFetch(url('alpha', base+'/sessions/plugin-suite/events')); assert.equal(r.status, 200); return r.json() as Promise<{events: {type: string; data: unknown}[]}>;};
  const inventory = () => api.call<{pluginId: string; agentId: string; packages: {packageId: string}[]; nextPackageId?: string; activeRun?: {pluginRunId: string}; latestRun: {status: string; packageId: string; approvalRequestId?: string}}[]>('dynamicCordisRunner/inventory', {});
  try {
    const original = await (await runtime.dispatchFetch(url('alpha', base+'/agents/default'))).json() as AgentRevision;
    const published = await runtime.dispatchFetch(url('alpha', base+'/agents'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({spec: {...original.spec, allowClientPlugins: true}, expectedRevision: original.revision})});
    assert.equal(published.status, 200, await published.clone().text());
    await api.call('session/create', {request: {sessionId: 'plugin-suite'}});
    await api.call('session/prompt', {request: {sessionId: 'plugin-suite', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Create the native counter plugin'}]}});
    const history = await idle();
    assert.ok(history.events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('awaiting-approval')), JSON.stringify(history.events.filter(event => ['tool/result', 'assistant/attempt', 'turn/end'].includes(event.type))));
    const [plugin] = await inventory(); assert.ok(plugin);
    assert.equal(plugin.latestRun.status, 'awaiting-approval');
    assert.equal(plugin.activeRun, undefined);
    const pluginId = plugin.pluginId, packageId = plugin.packages[0]!.packageId, requestId = plugin.latestRun.approvalRequestId!;
    await runtime.dispose(); runtime = createRuntime(directory, model);
    assert.equal((await inventory())[0]!.latestRun.approvalRequestId, requestId);
    const args = {agentId: 'plugin-suite', pluginId, packageId, mode: 'run', requestId, approveFutureVersions: false};
    assert.equal((await api.call<{ok: boolean}>('dynamicCordisRunner/runHostHalf', {...args, requestId: 'wrong-approval'})).ok, false);
    const started = await api.call<{ok: boolean; pluginRunId: string; message?: string}>('dynamicCordisRunner/runHostHalf', args);
    assert.equal(started.ok, true, JSON.stringify(started));
    const code = await api.call<{code: string}>('dynamicCordisRunner/getClientCode', {agentId: 'plugin-suite', pluginId, pluginRunId: started.pluginRunId});
    assert.equal(code.code, clientCode);
    assert.deepEqual(await api.call('dynamicCordisRunner/resolveRequestRun', {requestId, resolution: {ok: true, pluginRunId: started.pluginRunId}}), {accepted: true});
    await idle();
    const invoke = () => api.call('dynamicCordisRunner/invoke', {pluginId, pluginRunId: started.pluginRunId, method: 'increment', args: null});
    assert.deepEqual(await invoke(), {ok: true, value: {count: 1}});
    const file = await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files?path=/workspace/plugin-counter.txt'));
    assert.equal(file.status, 200); assert.match(await file.text(), /count:1/);
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})});
    const other = nativeClient(() => runtime, 'other');
    assert.deepEqual(await other.call('dynamicCordisRunner/inventory', {}), []);
    assert.equal((await other.raw('dynamicCordisRunner/invoke', {pluginId, pluginRunId: started.pluginRunId, method: 'increment', args: null})).result.ok, false);
    provider.requestUpdate();
    await api.call('session/prompt', {request: {sessionId: 'plugin-suite', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Prepare version two for review'}]}});
    await idle();
    const update = (await inventory())[0]!;
    assert.equal(update.packages.length, 2);
    assert.equal(update.latestRun.status, 'awaiting-approval');
    assert.notEqual(update.latestRun.packageId, packageId);
    assert.equal(update.activeRun?.pluginRunId, started.pluginRunId);
    assert.deepEqual(await invoke(), {ok: true, value: {count: 2}}, 'the old version keeps its capabilities while the update waits');
    await runtime.dispose(); runtime = createRuntime(directory, model);
    assert.equal((await api.call<{code: string}>('dynamicCordisRunner/getClientCode', {agentId: 'plugin-suite', pluginId, pluginRunId: started.pluginRunId})).code, clientCode, 'an approved live activation restores its stable identity');
    assert.deepEqual(await invoke(), {ok: true, value: {count: 1}}, 'the recovered facet is a fresh native plugin instance');
    const pending = (await inventory())[0]!;
    assert.equal(pending.latestRun.approvalRequestId, update.latestRun.approvalRequestId);
    assert.equal(pending.latestRun.status, 'awaiting-approval');
    assert.equal(pending.nextPackageId, update.nextPackageId);
    assert.deepEqual(await api.call('dynamicCordisRunner/resolveRequestRun', {requestId: pending.latestRun.approvalRequestId, resolution: {ok: false, reason: 'rejected'}}), {accepted: true});
    await idle();
    const rejected = (await inventory())[0]!;
    assert.equal(rejected.activeRun?.pluginRunId, started.pluginRunId);
    await runtime.dispose(); runtime = createRuntime(directory, model);
    await api.call('dynamicCordisRunner/getClientCode', {agentId: 'plugin-suite', pluginId, pluginRunId: started.pluginRunId});
    assert.equal((await inventory())[0]!.latestRun.status, rejected.latestRun.status, 'recovery preserves diagnostics for a different target version');
    assert.equal((await inventory())[0]!.latestRun.packageId, rejected.latestRun.packageId);
    assert.equal((await inventory())[0]!.nextPackageId, rejected.nextPackageId);
    assert.deepEqual(await api.call('dynamicCordisRunner/stopFromPanel', {agentId: 'plugin-suite', pluginId}), {ok: true});
    assert.equal((await inventory())[0]!.latestRun.status, 'stopped');
    assert.equal((await inventory())[0]!.activeRun, undefined);
    assert.equal((await api.call<{ok: boolean}>('dynamicCordisRunner/invoke', {pluginId, pluginRunId: started.pluginRunId, method: 'increment', args: null})).ok, false);
    await runtime.dispose(); runtime = createRuntime(directory, model);
    assert.equal((await inventory())[0]!.latestRun.status, 'stopped');
    assert.deepEqual(await api.call('dynamicCordisRunner/undefineFromPanel', {agentId: 'plugin-suite', pluginId}), {ok: true, wasRunning: false});
    assert.deepEqual(await inventory(), []);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('published authoring examples execute through the native approval and filesystem contracts', async () => {
  const provider = nativePluginModel({host: nativeHostExample, client: nativeClientExample}, true);
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-plugin-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: provider.outbound});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    const original = await (await runtime.dispatchFetch(url('alpha', base+'/agents/default'))).json() as AgentRevision;
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/agents'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({spec: {...original.spec, allowClientPlugins: true}, expectedRevision: original.revision})})).status, 200);
    await api.call('session/create', {request: {sessionId: 'authoring-example'}});
    await api.call('session/prompt', {request: {sessionId: 'authoring-example', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Use the documented plugin example'}]}});
    await (await runtime.dispatchFetch(url('alpha', base+'/sessions/authoring-example/events'))).json();
    const catalog = provider.inspection();
    assert.ok(catalog, 'the native inspection result must reach the model');
    assert.ok(catalog.services.every(service => ['fs', 'tools', 'timer'].includes(service.key)), 'do not advertise unbridged parent services');
    const fs = catalog.services.find(service => service.key === 'fs');
    assert.ok(fs);
    assert.ok(fs.methods.some(method => /\bwriteText\s*\(/.test(method.signature)));
    assert.ok(!fs.methods.some(method => /\bwatch\s*\(/.test(method.signature)), 'unbridged filesystem methods are not available');
    const [plugin] = await api.call<{pluginId: string; packages: {packageId: string}[]; latestRun: {approvalRequestId: string}}[]>('dynamicCordisRunner/inventory', {});
    assert.ok(plugin);
    const started = await api.call<{ok: boolean; pluginRunId: string}>('dynamicCordisRunner/runHostHalf', {agentId: 'authoring-example', pluginId: plugin.pluginId, packageId: plugin.packages[0]!.packageId, mode: 'run', requestId: plugin.latestRun.approvalRequestId, approveFutureVersions: false});
    assert.equal(started.ok, true);
    assert.deepEqual(await api.call('dynamicCordisRunner/resolveRequestRun', {requestId: plugin.latestRun.approvalRequestId, resolution: {ok: true, pluginRunId: started.pluginRunId}}), {accepted: true});
    assert.deepEqual(await api.call('dynamicCordisRunner/invoke', {pluginId: plugin.pluginId, pluginRunId: started.pluginRunId, method: 'save', args: 7}), {ok: true, value: {ok: true}});
    const file = await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files?path=/workspace/example.txt'));
    assert.equal(file.status, 200);
    assert.equal((await file.json() as {value: {content: string}}).value.content, '7');
  } finally {await runtime.dispose();}
});

test('native plugin facets keep real Cordis handlers and tools across requests, isolate owners and dispose registrations', {timeout: 90_000}, async () => {
  const options = convertV4MiniflareOptions({modules: true, scriptPath: resolve('dist/dynamic-worker.js'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], workerLoaders: {LOADER: {}}, durableObjects: {NATIVE_PLUGINS: {className: 'NativePluginBench', useSQLite: true}}, bindings: {PLATFORM_SECRET: 'must-stay-in-supervisor'}});
  options.workers[0]!.dev = {...options.workers[0]!.dev, unsafeRegisterWorker: false};
  const runtime = new Miniflare(options);
  const call = async (owner: string, action: string, fields: object = {}) => {
    const response = await runtime.dispatchFetch('http://localhost/native-plugin', {method: 'POST', body: JSON.stringify({owner, action, ...fields})});
    return {status: response.status, value: await response.json() as Record<string, unknown>};
  };
  const source = `let count = 0; return {name:'facet-counter',inject:['tools'],apply(ctx){harness.handle('increment',async()=>{let blocked=false;try{await fetch('https://example.com')}catch{blocked=true}const {env}=await import('cloudflare:workers');const process=await import('node:process');return {count:++count,blocked,secret:typeof env.PLATFORM_SECRET,processSecret:typeof process.default.env.PLATFORM_SECRET,bindings:Object.keys(env)}});ctx.tools.register(harness.defineTool({name:'facet_count',description:'Increment the isolated count',parameters:{},output:{schema:{type:'object',properties:{count:{type:'integer',required:true}},additionalProperties:false},render:(_args,value)=>[{type:'text',text:'Facet count '+value.count}],presentationMeta:(_args,value)=>({counter:value.count})},execute:async()=>({count:++count})}));}}`;
  try {
    for (const owner of ['alpha', 'beta']) {
      const started = await call(owner, 'start', {source});
      assert.equal(started.status, 200, JSON.stringify(started.value));
      assert.deepEqual(started.value.tools, ['facet_count']);
    }
    assert.deepEqual((await call('alpha', 'invoke', {method: 'increment'})).value, {count: 1, blocked: true, secret: 'undefined', processSecret: 'undefined', bindings: []});
    assert.equal((await call('alpha', 'invoke', {method: 'increment'})).value.count, 2);
    assert.equal((await call('beta', 'invoke', {method: 'increment'})).value.count, 1);
    const result = await call('alpha', 'tool', {method: 'facet_count', args: {}});
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.isError, false, JSON.stringify(result.value));
    assert.deepEqual(result.value.value, {count: 3});
    assert.deepEqual(result.value.content, [{type: 'text', text: 'Facet count 3'}]);
    assert.deepEqual(result.value.meta, {counter: 3});
    assert.deepEqual((await call('alpha', 'stop')).value, {tools: [], handlers: []});
    assert.equal((await call('beta', 'invoke', {method: 'increment'})).value.count, 2);
    assert.equal((await call('alpha', 'start', {source: 'throw new Error("isolated startup failure")'})).status, 400);
    assert.equal((await call('alpha', 'start', {source: 'return {apply(ctx){ctx.root}}'})).status, 400, 'the native guard withholds framework internals');
    assert.equal((await call('alpha', 'start', {source: 'return {inject:["systemPrompt"],apply(ctx){}}'})).status, 400, 'unsupported services must fail instead of silently modifying an isolated prompt');
    assert.equal((await call('hidden-services', 'start', {source: 'return {apply(ctx){harness.handle("inspect",()=>({prompt:typeof ctx.get("systemPrompt")}))}}'})).status, 200);
    assert.deepEqual((await call('hidden-services', 'invoke', {method: 'inspect'})).value, {prompt: 'undefined'}, 'optional service lookup cannot reach the internal ToolRuntime prompt');
    assert.equal((await call('alpha', 'start', {source})).status, 200);
    assert.equal((await call('alpha', 'invoke', {method: 'increment'})).value.count, 1);
    const cooperative = `let active=false,count=0;return {inject:['tools'],apply(ctx){harness.handle('status',()=>({active,count}));harness.handle('increment',()=>({count:++count}));ctx.tools.register(harness.defineTool({name:'facet_wait',description:'Wait for cancellation',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async(_args,exec)=>{active=true;try{await new Promise((_resolve,reject)=>{exec.signal.addEventListener('abort',()=>reject(new Error('cancel observed')),{once:true})})}finally{active=false}return null}}))}}`;
    assert.equal((await call('cancel-owner', 'start', {source: cooperative})).status, 200);
    await call('cancel-owner', 'invoke', {method: 'increment'});
    const pending = call('cancel-owner', 'tool', {method: 'facet_wait', args: {}});
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await call('cancel-owner', 'invoke', {method: 'status'})).value.active) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await call('cancel-owner', 'invoke', {method: 'status'})).value.active, true);
    await call('cancel-owner', 'cancel');
    assert.equal((await pending).value.isError, true);
    assert.deepEqual((await call('cancel-owner', 'invoke', {method: 'status'})).value, {active: false, count: 1});
    assert.equal((await call('cancel-owner', 'invoke', {method: 'increment'})).value.count, 2, 'cooperative cancellation keeps the plugin instance alive');
  } finally {await runtime.dispose();}
});
