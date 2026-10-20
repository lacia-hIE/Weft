import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the Models editor discovers the environment DeepSeek route from its adapter and rejects other endpoints', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'discovery-fixture', DEEPSEEK_BASE_URL: 'https://discovery-model.test/anthropic'}});
  const api = nativeClient(() => runtime);
  try {
    const catalog = await api.call<{groups: {models: {id: string}[]}[]}>('session/modelCatalog', {});
    const discovered = await api.call<{id: string; name?: string}[]>('llm/discoverModels', {settingsNs: 'llm-deepseek', request: {provider: 'deepseek-official'}});
    assert.ok(discovered.length > 0);
    assert.deepEqual(discovered.map(model => model.id), catalog.groups.flatMap(group => group.models.map(model => model.id)), 'discovery and the session model catalog read the same adapter registry');
    const custom = await api.raw('llm/discoverModels', {settingsNs: 'llm-deepseek', request: {baseURL: 'https://example.invalid/v1'}});
    assert.equal(custom.result.error?.code, 'llm/model-discovery-rejected');
  } finally {
    await runtime.dispose();
  }
});
