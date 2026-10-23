import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import type {BundleInfo, ChangeResult, PluginInfo} from '@deepseek-ai/dsh-plugin-manager/types';

test('Worker bundles use native patches, isolate settings, and unload/reload tools in a live Session', {timeout: 120000}, async () => {
  for (const kind of ['javascript', 'documents']) {
    const directory = new URL('../packages/worker-plugins/'+kind+'/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    const patch = JSON.parse(await readFile(new URL(manifest.dsh.bundle.patch, directory), 'utf8'));
    assert.ok(patch[0].insert.length > 0);
  }
  const observations: string[][] = [];
  const directory = await mkdtemp(join(tmpdir(), 'weft-worker-plugins-'));
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'plugin-test', DEEPSEEK_BASE_URL: 'https://worker-plugins.test/anthropic'}, outbound: async (request: Request) => {
    const body = await request.json() as {tools?: {name: string}[]};
    observations.push((body.tools ?? []).map(tool => tool.name));
    return nativeFixtureResponse();
  }};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime), other = nativeClient(() => runtime, 'other');
  const run = async () => {
    const follow = await api.follow('worker-plugin-live'); await follow.next();
    try {
      await api.call('session/prompt', {request: {sessionId: 'worker-plugin-live', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Inspect tools'}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
    return observations.at(-1)!;
  };
  try {
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})})).status, 201);
    const bundles = await api.call<BundleInfo[]>('pluginManager/listBundles', {});
    const worker = bundles.filter(bundle => ['@weft/worker-javascript', '@weft/worker-documents'].includes(bundle.name));
    assert.equal(worker.length, 2); assert.ok(worker.every(bundle => bundle.enabled && bundle.installed && !bundle.official));
    const plugins = await api.call<PluginInfo[]>('pluginManager/listPlugins', {});
    assert.ok(plugins.some(plugin => plugin.entryId === 'weft-javascript' && plugin.patchId === 'weft-javascript'));
    await api.call('session/create', {request: {sessionId: 'worker-plugin-live', agentPreset: 'standard'}});
    let tools = await run(); assert.ok(tools.includes('javascript_task')); assert.ok(tools.includes('document_to_markdown'));
    assert.equal((await api.call<ChangeResult>('pluginManager/setBundleEnabled', {name: '@weft/worker-javascript', enabled: false})).application, 'applied');
    tools = await run(); assert.ok(!tools.includes('javascript_task')); assert.ok(tools.includes('document_to_markdown'));
    assert.equal((await other.call<BundleInfo[]>('pluginManager/listBundles', {})).find(bundle => bundle.name === '@weft/worker-javascript')?.enabled, true);
    await api.call('pluginManager/setPluginEnabled', {id: 'weft-documents', enabled: false});
    tools = await run(); assert.ok(!tools.includes('document_to_markdown'));
    assert.equal((await api.raw('settings/update', {ns: 'weft-documents', patch: {maxInputMiB: 11}})).result.ok, false);
    await api.call('settings/update', {ns: 'weft-documents', patch: {enabled: true, maxInputMiB: 2, previewCharacters: 100}});
    await api.call('pluginManager/setBundleEnabled', {name: '@weft/worker-javascript', enabled: true});
    tools = await run(); assert.ok(tools.includes('javascript_task')); assert.ok(tools.includes('document_to_markdown'));
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const config = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/native/worker-plugins`));
    assert.equal(config.headers.get('cache-control'), 'private, no-store');
    assert.equal((await config.json() as {documents: {maxInputMiB: number}}).documents.maxInputMiB, 2);
    assert.equal((await api.call<ChangeResult>('pluginManager/removeBundle', {name: '@weft/worker-documents'})).error?.code, 'not-removable');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
