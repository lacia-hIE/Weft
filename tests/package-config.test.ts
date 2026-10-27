import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Response} from 'miniflare';
import type {SettingsDescribeValue, SettingsNamespaceView} from '@deepseek-ai/dsh-settings/types';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {packageModel} from './helpers/package-model.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';

test('an installed entry is configured through native Settings, secrets stay redacted and activations restart with the value', {timeout: 150000}, async () => {
  const fixture = packageFixture({client: false, files: {'host.js': `
    import Schema from '@deepseek-ai/schemastery';
    import {defineTool} from '@deepseek-ai/dsh-tools';
    export const inject=['fs','tools'];
    export const Config=Schema.object({filename:Schema.string().required(),value:Schema.string().default('fallback'),token:Schema.string().role('secret').default('')});
    export function apply(ctx,config){ctx.tools.register(defineTool({name:'package_save',description:'Save the configured value',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>{
      await ctx.fs.writeText(await ctx.fs.resolve(config.filename),config.value+'|'+config.token);return {saved:true};
    }}));}`}}), model = packageModel();
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'package-fixture', DEEPSEEK_BASE_URL: 'https://package-model.test/anthropic'},
    outbound: async (request, mf) => {
      if (new URL(request.url).hostname === 'package-model.test') return model.outbound(request, mf);
      return request.url === fixture.manifest.dist.tarball ? new Response(fixture.bytes) : Response.json(fixture.manifest);
    }, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
  });
  const api = nativeClient(() => runtime), base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const operation = (body: object) => runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const installed = async () => (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
  const ns = entryNamespace(fixture.name, 'counter');
  const form = async () => (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns);
  const saved = async (sessionId: string) => {
    const follow = await api.follow(sessionId); await follow.next();
    try {
      await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'SAVE_PACKAGE ' + crypto.randomUUID()}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
    return (await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files?path=/workspace/package-result.txt'))).text();
  };
  try {
    await api.call('pluginManager/installBundle', {spec: `${fixture.name}@${fixture.version}`, options: {requestId: crypto.randomUUID()}});
    const row = await installed();
    assert.deepEqual(row.configs?.map(entry => entry.id), ['counter'], 'Inspection records the entry schema with the exact artifact');
    assert.equal((await operation({operation: 'approve', name: row.name, digest: row.digest})).status, 200);
    const bundle = (await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(item => item.name === fixture.name)!;
    assert.deepEqual(bundle.rows.map(item => item.rowId), [ns], 'The Plugin Manager row opens the namespace of its form');

    const initial = (await form())!;
    assert.deepEqual({...initial.value as object, token: undefined}, {filename: '/workspace/package-result.txt', value: 'from-patch', token: undefined});
    await api.call('session/create', {request: {sessionId: 'configured'}});
    assert.equal(await saved('configured'), 'from-patch|');

    const edited = await api.call<SettingsNamespaceView>('settings/update', {ns, patch: {value: 'edited', token: 'secret-token'}, expectedRevision: initial.revision});
    const value = edited.value as {value?: unknown; token?: unknown};
    assert.equal(value.value, 'edited');
    assert.notEqual(value.token, 'secret-token', 'Secret fields are redacted for clients');
    assert.equal((await api.raw('settings/update', {ns, patch: {value: 'stale'}, expectedRevision: initial.revision})).result.error?.code, 'settings/conflict');
    assert.equal((await api.raw('settings/update', {ns, patch: {value: 42}, expectedRevision: edited.revision})).result.error?.code, 'settings/rejected', 'The plugin schema rejects a mistyped field');
    assert.equal((await api.raw('settings/update', {ns, patch: {unknown: true}, expectedRevision: edited.revision})).result.error?.code, 'settings/rejected');
    assert.equal(await saved('configured'), 'edited|secret-token', 'The running Session restarts its activation with the new configuration');

    await api.call('pluginManager/removeBundle', {name: fixture.name});
    assert.equal(await form(), undefined, 'A removed bundle leaves no form');
  } finally {await runtime.dispose();}
});
