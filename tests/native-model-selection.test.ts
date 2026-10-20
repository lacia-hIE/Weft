import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionProjectionsValue, ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('native model selection drives actual requests, persists intent and rejects unavailable routes without changing it', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-model-'));
  const routes: {model: string; thinking?: {type: string}; output_config?: {effort: string}}[] = [];
  const bindings = {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'model-selection-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'};
  const outbound: V4FetchHandler = async (request) => {
    routes.push(await request.json() as typeof routes[number]);
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'selected route response'}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  };
  let runtime = createRuntime(directory, {browser: true, bindings, outbound});
  const api = nativeClient(() => runtime);
  const projections = () => api.call<SessionProjectionsValue>('session/projections', {request: {sessionId: 'choice'}});
  const send = async () => {
    await api.call('session/prompt', {request: {sessionId: 'choice', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'use selected route'}]}});
    const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/choice/events`));
    assert.equal(response.status, 200); // serialized read waits for the real native turn
  };
  try {
    const catalog = await api.call<ModelCatalog>('session/modelCatalog', {});
    assert.ok(catalog.groups[0]!.models.some(model => model.id === 'deepseek-v4-pro'));
    await api.call('session/create', {request: {sessionId: 'choice'}});
    const blank = await projections();
    assert.equal(blank?.kind, 'sequenced');
    if (blank?.kind !== 'sequenced') throw new Error('Missing native projections');
    assert.deepEqual(blank.values.modelSelection, {lastUsed: null, next: null});
    const selected = await api.call<{selected: {provider: string; model: string}}>('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'deepseek-v4-pro'}});
    assert.equal(selected.selected.model, 'deepseek-v4-pro');
    assert.equal(routes.length, 0, 'selection never calls the inference endpoint');
    assert.equal((await api.raw('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'not-configured'}})).result.error?.code, 'session/model-unavailable');
    assert.equal((await api.raw('session/selectModel', {request: {sessionId: 'choice', provider: 'outside', model: 'deepseek-v4-pro'}})).result.error?.code, 'session/model-unavailable');
    assert.equal((await api.raw('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'invented'}})).result.error?.code, 'session/model-unavailable');
    const pending = await projections();
    if (pending?.kind !== 'sequenced') throw new Error('Missing pending selection');
    assert.equal(pending.values.modelSelection?.next?.model, 'deepseek-v4-pro');
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true, bindings, outbound});
    await send();
    assert.equal(routes.at(-1)!.model, 'deepseek-v4-pro');
    const used = await projections();
    if (used?.kind !== 'sequenced') throw new Error('Missing used selection');
    assert.equal(used.values.modelSelection?.lastUsed?.model, 'deepseek-v4-pro');
    await api.call('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'deepseek-flash'}});
    await send();
    assert.equal(routes.at(-1)!.model, 'deepseek-flash');
    assert.deepEqual([routes.at(-1)!.thinking, routes.at(-1)!.output_config], [{type: 'enabled'}, {effort: 'high'}], 'the original adapter thinks at its default effort');
    await api.call('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low'}});
    await send();
    assert.deepEqual([routes.at(-1)!.thinking, routes.at(-1)!.output_config], [{type: 'enabled'}, {effort: 'low'}], 'the Session thinking level reaches the request');
    await api.call('session/selectModel', {request: {sessionId: 'choice', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off'}});
    await send();
    assert.deepEqual([routes.at(-1)!.thinking, routes.at(-1)!.output_config], [{type: 'disabled'}, undefined]);
    const current = await projections();
    if (current?.kind !== 'sequenced') throw new Error('Missing final cursor');
    const page = await api.call('session/page', {request: {address: {kind: 'session', sessionId: 'choice'}, throughSeq: current.asOfSeq}});
    assert.match(JSON.stringify(page), /model-selection/);
    assert.match(JSON.stringify(page), /deepseek-v4-pro → deepseek-flash/);
  } finally { await runtime.dispose(); await rm(directory, {recursive: true, force: true}); }
});
