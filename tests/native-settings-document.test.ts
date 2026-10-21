import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the configuration document opens in the workspace and replaces the configuration only when every row passes', {timeout: 120_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const files = url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`);
  const read = async (path: string) => {
    const response = await runtime.dispatchFetch(`${files}?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as {value: {content: string; version: string}}).value;
  };
  const save = async (content: string, expectedVersion: string) => {
    const response = await runtime.dispatchFetch(files, {method: 'PUT', headers: {'content-type': 'application/json', origin: new URL(files).origin}, body: JSON.stringify({path: '/workspace/.dsh/profile.yml', content, expectedVersion})});
    assert.equal(response.status, 200, await response.clone().text());
  };
  const loop = async () => (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(ns => ns.ns === 'agent-loop')!;
  const parallel = async () => ((await loop()).value as {maxParallelToolCalls?: number}).maxParallelToolCalls;
  try {
    assert.equal((await api.call<SettingsDescribeValue>('settings/describe', {})).hasDocument, true);
    await api.call<SettingsNamespaceView>('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 3}, expectedRevision: (await loop()).revision});
    assert.deepEqual(await api.call('settings/openSettingsDocument', {}), {opened: true});
    const opened = await read('/workspace/.dsh/profile.yml');
    assert.match(opened.content, /id: agent-loop[\s\S]*maxParallelToolCalls: 3/, opened.content);

    await save('- id: agent-loop\n  config:\n    maxParallelToolCalls: 5\n', opened.version);
    assert.equal((await parallel()), 5, 'a saved document replaces the configuration');

    const edited = await read('/workspace/.dsh/profile.yml');
    await save('- id: agent-loop\n  config:\n    maxParallelToolCalls: many\n- id: no-such-entry\n', edited.version);
    assert.equal((await parallel()), 5, 'a rejected document leaves the configuration unchanged');
    assert.match((await read('/workspace/.dsh/profile.error.txt')).content, /agent-loop/);

    const rejected = await read('/workspace/.dsh/profile.yml');
    await save('[]\n', rejected.version);
    assert.notEqual((await parallel()), 5, 'an entry the document leaves out returns to its profile configuration');
    await api.call<SettingsNamespaceView>('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 2}, expectedRevision: (await loop()).revision});
    assert.match((await read('/workspace/.dsh/profile.yml')).content, /maxParallelToolCalls: 2/, 'a form edit rewrites the open document');
  } finally {
    await runtime.dispose();
  }
});
