import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only the third-party endpoint is served by the fixture; the directory, discovery and catalog are the official entries'. */
test('the official model entries serve the provider directory, third-party discovery and the session catalog', {timeout: 90_000}, async () => {
  const gateway: string[] = [];
  const outbound: V4FetchHandler = async request => {
    const target = new URL(request.url);
    if (target.origin !== 'https://gateway.test') throw new Error(`Unexpected model outbound ${request.url}`);
    gateway.push(`${target.pathname} ${request.headers.get('authorization') ?? ''}`);
    return Response.json({object: 'list', data: [{id: 'gateway-coder', object: 'model'}, {id: 'gateway-chat', object: 'model'}]});
  };
  const runtime = createRuntime(undefined, {browser: true, outbound, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'discovery-fixture', DEEPSEEK_BASE_URL: 'https://discovery-model.test/anthropic'}});
  const api = nativeClient(() => runtime);
  try {
    const directory = await api.call<{provider: string; settingsNs: string}[]>('llm/listConfigurableProviders', {});
    assert.deepEqual(directory.find(row => row.provider === 'deepseek-official')?.settingsNs, 'llm-deepseek');
    for (const provider of ['openai', 'anthropic']) assert.equal(directory.find(row => row.provider === provider)?.settingsNs, 'llm-pi-ai', `${provider} is offered by the third-party adapter`);

    const catalog = await api.call<{groups: {id: string; models: {id: string}[]}[]}>('session/modelCatalog', {});
    assert.deepEqual(catalog.groups.map(group => group.id), ['deepseek-official']);
    assert.ok(catalog.groups[0]!.models.length > 0);
    // As in the original Host, only the third-party adapter offers endpoint discovery.
    assert.equal((await api.raw('llm/discoverModels', {settingsNs: 'llm-deepseek', request: {provider: 'deepseek-official'}})).result.error?.code, 'llm/model-discovery-rejected');

    const discovered = await api.call<{id: string}[]>('llm/discoverModels', {settingsNs: 'llm-pi-ai', request: {baseURL: 'https://gateway.test/v1', apiKey: 'gateway-draft-key'}});
    assert.deepEqual(discovered.map(model => model.id).sort(), ['gateway-chat', 'gateway-coder']);
    assert.deepEqual(gateway, ['/v1/models Bearer gateway-draft-key']);

    await api.call('credentials/set', {ref: 'GATEWAY_API_KEY', value: 'gateway-stored-key'});
    await api.call('settings/update', {ns: 'llm-pi-ai', patch: {providers: {gateway: {displayName: 'Gateway', api: 'openai-completions', baseURL: 'https://gateway.test/v1', apiKeyEnv: 'GATEWAY_API_KEY', models: [{id: 'gateway-coder', name: 'Gateway Coder'}]}}}, expectedRevision: 0});
    const updated = await api.call<{groups: {id: string; models: {id: string}[]}[]}>('session/modelCatalog', {});
    assert.deepEqual(updated.groups.find(group => group.id === 'gateway')?.models.map(model => model.id), ['gateway-coder'], 'a saved third-party route joins the catalog');
    const insecure = await api.raw('settings/update', {ns: 'llm-pi-ai', patch: {providers: {plain: {displayName: 'Plain', api: 'openai-completions', baseURL: 'http://gateway.test/v1', models: [{id: 'm', name: 'M'}]}}}});
    assert.equal(insecure.result.ok, false, 'third-party endpoints must use HTTPS');
  } finally {
    await runtime.dispose();
  }
});
