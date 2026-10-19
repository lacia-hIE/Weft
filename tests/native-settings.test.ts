import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('native settings and write-only credentials persist by environment and control real provider requests', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-settings-'));
  const calls: {url: string; key: string | null; body: {model: string; max_tokens: number}}[] = [];
  const outbound: V4FetchHandler = async request => {
    calls.push({url: request.url, key: request.headers.get('x-api-key'), body: await request.json() as {model: string; max_tokens: number}});
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'configured response'}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  };
  const bindings = {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'platform-settings-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'};
  let runtime = createRuntime(directory, {browser: true, configureModel: false, scriptPath: 'dist/worker.js', bindings, outbound});
  const a = nativeClient(() => runtime, 'a'), b = nativeClient(() => runtime, 'b');
  const provider = 'llm-deepseek';
  const describe = () => a.call<SettingsDescribeValue>('settings/describe', {});
  const send = async (api: ReturnType<typeof nativeClient>, environment: string, sessionId: string) => {
    await api.call('session/create', {request: {sessionId}});
    await api.call('session/prompt', {request: {sessionId, requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'reply'}]}});
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/${environment}/sessions/${sessionId}/events`))).status, 200);
  };
  try {
    for (const id of ['a', 'b']) assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id, name: id})})).status, 201);
    const initial = await describe();
    assert.equal(initial.writable, true); assert.equal(initial.hasDocument, false);
    const ns = initial.namespaces.find(row => row.ns === provider)!;
    assert.equal(ns.revision, 0);
    assert.match(JSON.stringify(ns.schema), /credential-ref/);
    assert.doesNotMatch(JSON.stringify(initial), /platform-settings-fixture/);
    const events = await a.events();
    await events.next();
    try {
      await a.call('credentials/set', {ref: 'PROJECT_KEY', value: 'only-environment-a-fixture'});
      assert.match(JSON.stringify(await events.next()), /credentials\/reference-updated/);
      assert.deepEqual(await a.call('credentials/describe', {refs: ['PROJECT_KEY', 'DEEPSEEK_API_KEY']}), {PROJECT_KEY: {configured: true, source: 'environment', writable: true}, DEEPSEEK_API_KEY: {configured: false, writable: true}});
      assert.deepEqual(await b.call('credentials/describe', {refs: ['PROJECT_KEY']}), {PROJECT_KEY: {configured: false, writable: true}});
      const changed = await a.call<SettingsNamespaceView>('settings/update', {ns: provider, patch: {apiKeyEnv: 'PROJECT_KEY', baseURL: 'https://project.test/anthropic', maxTokens: 37, models: [{id: 'project-coder', name: 'Project Coder'}]}, expectedRevision: ns.revision});
      assert.equal(changed.revision, 1);
      assert.match(JSON.stringify(await events.next()), /settings\/document-updated/);
      assert.equal((await a.raw('settings/update', {ns: provider, patch: {maxTokens: 12}, expectedRevision: 0})).result.error?.code, 'settings/conflict');
      assert.equal((await a.raw('settings/update', {ns: provider, patch: {baseURL: 'http://outside.test'}, expectedRevision: 1})).result.error?.code, 'settings/rejected');
      assert.equal((await a.raw('settings/update', {ns: provider, patch: {unknown: 'field'}, expectedRevision: 1})).result.error?.code, 'settings/rejected');
      const path = await a.call<SettingsNamespaceView>('settings/mutate', {ns: provider, ops: [{op: 'set', path: ['models', '0', 'name'], value: 'Renamed Coder'}], expectedRevision: 1});
      assert.equal(path.revision, 2);
      assert.match(JSON.stringify(path.value), /Renamed Coder/);
    } finally { await events.close(); }
    assert.equal((await describe()).namespaces.find(row => row.ns === provider)!.revision, 2);
    assert.equal((await b.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === provider)!.revision, 0);
    const inherited = await b.call<SettingsNamespaceView>('settings/mutate', {ns: provider, ops: [{op: 'set', path: ['models', '0', 'name'], value: 'Inherited array edited'}], expectedRevision: 0});
    assert.match(JSON.stringify(inherited.value), /Inherited array edited/);
    const reset = await b.call<SettingsNamespaceView>('settings/mutate', {ns: provider, ops: [{op: 'unset', path: ['models']}], expectedRevision: 1});
    assert.doesNotMatch(JSON.stringify(reset.value), /Inherited array edited/);
    assert.equal(calls.length, 0, 'configuration and credential mutation never call inference');
    await a.call('session/create', {request: {sessionId: 'choose'}});
    await a.call('session/selectModel', {request: {sessionId: 'choose', provider: 'deepseek-official', model: 'project-coder'}});
    assert.match(JSON.stringify((await describe()).namespaces.find(row => row.ns === 'agent-default-model')!.value), /project-coder/);
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true, configureModel: false, scriptPath: 'dist/worker.js', bindings, outbound});
    await send(a, 'a', 'after-restart');
    assert.equal(calls.at(-1)!.body.model, 'project-coder');
    assert.equal(calls.at(-1)!.body.max_tokens, 37);
    assert.equal(calls.at(-1)!.key, 'only-environment-a-fixture');
    assert.equal(new URL(calls.at(-1)!.url).hostname, 'project.test');
    await b.call('credentials/set', {ref: 'DEEPSEEK_API_KEY', value: 'only-environment-b-fixture'});
    await send(b, 'b', 'other-environment');
    assert.equal(calls.at(-1)!.body.model, 'deepseek-flash');
    assert.equal(calls.at(-1)!.key, 'only-environment-b-fixture');
    assert.equal(calls.at(-1)!.body.max_tokens, 8192);
    assert.doesNotMatch(JSON.stringify(await describe()), /only-environment-a-fixture|platform-settings-fixture/);
    await a.call('credentials/unset', {ref: 'PROJECT_KEY'});
    assert.deepEqual(await a.call('credentials/describe', {refs: ['PROJECT_KEY']}), {PROJECT_KEY: {configured: false, writable: true}});
    assert.equal((await a.raw('credentials/describe', {refs: ['not/a/ref']})).result.error?.code, 'gateway/bad-request');
    assert.equal((await a.raw('credentials/set', {ref: 'PROJECT_KEY', value: 123})).result.error?.code, 'gateway/bad-request');
    assert.equal((await a.raw('settings/update', {ns: provider, patch: [], expectedRevision: 0})).result.error?.code, 'gateway/bad-request');
  } finally { await runtime.dispose(); await rm(directory, {recursive: true, force: true}); }
});

test('production ignores all legacy model bindings and uses only user model settings, including after key removal', {timeout: 60_000}, async () => {
  const calls: {url: string; key: string | null}[] = [];
  const runtime = createRuntime(undefined, {browser: true, configureModel: false, scriptPath: 'dist/worker.js', bindings: {MODEL_BACKEND: 'scripted', DEEPSEEK_API_KEY: 'legacy-host-fixture', DEEPSEEK_MODEL: 'legacy-host-model', DEEPSEEK_BASE_URL: 'https://legacy.test/anthropic', TENANT_MODEL_CONFIG_JSON: '{broken', MODEL_IDLE_TIMEOUT_MS: 'invalid', MODEL_TURN_TIMEOUT_MS: 'invalid'}, outbound: async request => {
    calls.push({url: request.url, key: request.headers.get('x-api-key')});
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
    return new Response(event('message_start', {message: {usage: {input_tokens: 1, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: {type: 'text', text: 'user credential'}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  }});
  const api = nativeClient(() => runtime);
  const prompt = () => api.raw('session/prompt', {request: {sessionId: 'user-model', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'reply'}]}});
  const idle = () => runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/user-model/events`));
  try {
    const settings = await api.call<SettingsDescribeValue>('settings/describe', {});
    const provider = settings.namespaces.find(row => row.ns === 'llm-deepseek')!;
    assert.match(JSON.stringify(provider.value), /api.deepseek.com/);
    assert.doesNotMatch(JSON.stringify(settings), /legacy-host|legacy.test/);
    assert.deepEqual(await api.call('credentials/describe', {refs: ['DEEPSEEK_API_KEY']}), {DEEPSEEK_API_KEY: {configured: false, writable: true}});
    const catalog = await api.call<{default: {model: string}}>('session/modelCatalog', {});
    assert.equal(catalog.default.model, 'deepseek-flash');
    await api.call('session/create', {request: {sessionId: 'user-model'}});
    assert.equal((await prompt()).result.error?.code, 'session/provider-credentials-unavailable');
    await api.call('settings/update', {ns: 'llm-deepseek', patch: {baseURL: 'https://user.test/anthropic'}, expectedRevision: 0});
    assert.equal((await prompt()).result.error?.code, 'session/provider-credentials-unavailable');
    assert.equal(calls.length, 0);
    await api.call('credentials/set', {ref: 'DEEPSEEK_API_KEY', value: 'user-owned-fixture'});
    assert.equal((await prompt()).result.ok, true);
    assert.equal((await idle()).status, 200);
    assert.deepEqual(calls, [{url: 'https://user.test/anthropic/v1/messages', key: 'user-owned-fixture'}]);
    await api.call('credentials/unset', {ref: 'DEEPSEEK_API_KEY'});
    assert.equal((await prompt()).result.error?.code, 'session/provider-credentials-unavailable');
    assert.equal(calls.length, 1, 'a warm Agent must not use an old snapshot or a host credential');
  } finally {await runtime.dispose();}
});

test('a live native turn adopts configuration and credential changes at its next model step', {timeout: 60_000}, async () => {
  let first!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {first = resolve;});
  const proceed = new Promise<void>(resolve => {release = resolve;});
  const calls: {url: string; key: string | null; maxTokens: number}[] = [];
  const outbound: V4FetchHandler = async request => {
    const body = await request.json() as {max_tokens: number};
    calls.push({url: request.url, key: request.headers.get('x-api-key'), maxTokens: body.max_tokens});
    const tool = calls.length === 1;
    if (tool) {first(); await proceed;}
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'identity-live', name: 'tenant_identity', input: {}} : {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: '{}'} : {type: 'text_delta', text: 'updated'}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'before-fixture', DEEPSEEK_BASE_URL: 'https://before.test/anthropic'}, outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'live'}});
    await api.call('session/prompt', {request: {sessionId: 'live', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'use your identity tool'}]}});
    await started;
    await api.call('credentials/set', {ref: 'NEXT_KEY', value: 'after-fixture'});
    await api.call('settings/update', {ns: 'llm-deepseek', patch: {apiKeyEnv: 'NEXT_KEY', baseURL: 'https://after.test/anthropic', maxTokens: 41}, expectedRevision: 1});
    release();
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/live/events`))).status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => [new URL(call.url).hostname, call.key, call.maxTokens]), [['before.test', 'before-fixture', 8192], ['after.test', 'after-fixture', 41]]);
  } finally {release(); await runtime.dispose();}
});
