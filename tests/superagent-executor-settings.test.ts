import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Response} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {entryNamespace, type Installation} from '../packages/package-install/src/contracts.ts';

test('executor selection persists and returns without draining a main Session before setup', {timeout: 60000}, async () => {
  const plugin = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string; version: string};
  const runtime = createRuntime(undefined, {packages: true, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api = nativeClient(() => runtime), base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const key = 'pending-setup-executor-test';
  const panel = (path: string, method = 'GET', body?: unknown) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenantId('alpha')}/default/${encodeURIComponent(plugin.name)}/api/${path}`),
    {method, headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)} as never);
  try {
    await api.call('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: row.permissions})})).status, 200);
    const ns = entryNamespace(plugin.name, 'dsh-superagent');
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns)!;
    await api.call('settings/update', {ns, patch: {managementKey: key}, expectedRevision: form.revision});
    let state = await panel('state');
    for (let attempt = 0; state.status !== 200 && attempt < 40; attempt++) {await new Promise(resolve => setTimeout(resolve, 100)); state = await panel('state');}
    assert.equal(state.status, 200, await state.clone().text());
    assert.ok((await state.json() as {setup: {problem: unknown}}).setup.problem);
    const read = async () => await (await panel('settings')).json() as {blocks: {executor: {revision: number; value: Record<string, unknown>}}};
    const current = (await read()).blocks.executor;
    const device = await panel('executors', 'POST', {name: 'Connected DSH'}); assert.equal(device.status, 200);
    const {id} = await device.json() as {id: string};
    const value = {...current.value, executorId: id};
    const saved = await panel('settings/executor', 'PUT', {revision: current.revision, value});
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await saved.json(), {saved: true, revision: current.revision + 1, policy_changed: false, restarting: false, context_delivery: 'pending'});
    const next = (await read()).blocks.executor; assert.equal(next.value.executorId, id);
    const repeated = await panel('settings/executor', 'PUT', {revision: next.revision, value});
    assert.equal(repeated.status, 200); assert.equal((await repeated.json() as {restarting: boolean}).restarting, false);
  } finally {await runtime.dispose();}
});
