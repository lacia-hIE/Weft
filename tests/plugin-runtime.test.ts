import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {readPluginRuntime} from '../packages/native-composition/src/runtime.ts';
import type {PluginRuntimeSnapshot} from '../packages/native-composition/src/runtime-contract.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

test('runtime diagnostics read real fibers, report missing dependencies and never export raw errors or configuration', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin({name: 'fixture-active', apply() {}});
    ctx.plugin({name: 'fixture-pending', inject: ['fixtureUnavailable'], apply() {}});
    try {await ctx.plugin({name: 'fixture-failed', apply(_ctx: Context, _config: {password: string}) {throw new Error('apiKey=fixture-private-secret');}}, {password: 'another-private-secret'});} catch {}
    const snapshot = await readPluginRuntime(ctx);
    assert.equal(snapshot.entries.find(row => row.moduleName === 'fixture-active')?.phase, 'active');
    const pending = snapshot.entries.find(row => row.moduleName === 'fixture-pending');
    assert.ok(pending);
    assert.equal(pending?.phase, 'pending');
    assert.deepEqual(pending.missingServices, ['fixtureUnavailable']);
    assert.deepEqual(snapshot.entries.find(row => row.moduleName === 'fixture-failed')?.failure, {kind: 'startup', name: 'Error'});
    assert.doesNotMatch(JSON.stringify(snapshot), /private-secret|password|apiKey/);
    assert.equal(snapshot.truncated, false);
  } finally {await ctx.fiber.dispose();}
});

test('authenticated Session diagnostics do not wake inactive owners, observe real Loader changes and preserve environment boundaries', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-runtime-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const inspect = async () => {
    const response = await runtime.dispatchFetch(url('alpha', base+'/native/plugins/runtime?sessionId=observed'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return await response.json() as PluginRuntimeSnapshot;
  };
  try {
    await api.call('session/create', {request: {sessionId: 'observed'}});
    assert.equal((await inspect()).state, 'inactive');
    assert.equal((await inspect()).entries.length, 0);
    await api.call('commands/list', {agentId: 'observed'});
    const active = await inspect();
    assert.equal(active.state, 'active');
    assert.equal(active.entries.find(row => row.entryId === 'llm')?.phase, 'active');
    assert.equal(active.entries.find(row => row.entryId === 'command-feedback')?.phase, 'active');
    await api.call('pluginManager/setPluginEnabled', {id: 'command-feedback', enabled: false});
    assert.equal((await inspect()).entries.find(row => row.entryId === 'command-feedback')?.phase, 'active', 'configured enablement is distinct from the current live world');
    await api.call('session/prompt', {request: {sessionId: 'observed', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Hello'}]}});
    await (await runtime.dispatchFetch(url('alpha', base+'/sessions/observed/events'))).json();
    assert.equal((await inspect()).entries.find(row => row.entryId === 'command-feedback')?.phase, 'disabled');
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/native/plugins/runtime?sessionId=absent'))).status, 404);
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/native/plugins/runtime?sessionId=observed'), {method: 'POST'})).status, 405);
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('beta')}/environments/default/native/plugins/runtime?sessionId=observed`))).status, 403);
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})})).status, 201);
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/other/native/plugins/runtime?sessionId=observed`))).status, 404);
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    assert.equal((await inspect()).state, 'inactive', 'reading diagnostics after restart does not rebuild the Agent');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
