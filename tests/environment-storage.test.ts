import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {SettingsDescribeValue, SettingsNamespaceView} from '@deepseek-ai/dsh-settings/types';
import type {WorkspaceCreateValue, WorkspaceFollowFrame} from '@deepseek-ai/dsh-api-workspace-controller/types';

const options = {browser: true, configureModel: false, scriptPath: 'dist/environment-storage-worker.js'};

test('environment settings, plugin switches, presets and workspace membership work without a D1 binding, including after cold restart', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-environment-storage-'));
  let runtime = createRuntime(directory, options);
  const a = nativeClient(() => runtime, 'a'), b = nativeClient(() => runtime, 'b');
  const describe = (api = a) => api.call<SettingsDescribeValue>('settings/describe', {});
  try {
    for (const id of ['a', 'b']) {
      const created = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id, name: id})});
      assert.equal(created.status, 201);
    }
    const db = await runtime.getD1Database('CONFIG_DB', 'alpha');
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations'").all<{name: string}>();
    assert.deepEqual(tables.results.map(row => row.name).sort(), ['environments'], 'D1 holds no environment-internal tables');
    const updates = await Promise.all([
      a.raw('settings/update', {ns: 'agent-loop', expectedRevision: 0, patch: {maxParallelToolCalls: 3}}),
      a.raw('settings/update', {ns: 'agent-loop', expectedRevision: 0, patch: {maxParallelToolCalls: 7}}),
    ]);
    assert.equal(updates.filter(row => row.result.ok).length, 1);
    assert.equal(updates.filter(row => row.result.error?.code === 'settings/conflict').length, 1);
    const winner = (await describe()).namespaces.find(row => row.ns === 'agent-loop')!;
    assert.equal(winner.revision, 1);
    assert.equal((await describe(b)).namespaces.find(row => row.ns === 'agent-loop')!.revision, 0);
    await a.call('credentials/set', {ref: 'LOCAL_KEY', value: 'environment-a-only'});
    const project = await a.call<WorkspaceCreateValue>('workspace/create', {request: {path: await a.call<string>('directoryPicker/createDirectory', {path: '/workspace', name: 'project'})}});
    await a.call('session/create', {request: {sessionId: 'local-session', workspaceId: project.workspace.workspaceId}});
    await a.call('workspace/pinSession', {request: {sessionId: 'local-session'}});
    const bundleSwitch = await a.call<SettingsNamespaceView>('settings/update', {ns: 'weft-javascript', expectedRevision: 0, patch: {enabled: false}});
    assert.equal(bundleSwitch.revision, 1);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const restored = (await describe()).namespaces.find(row => row.ns === 'agent-loop')!;
    assert.deepEqual(restored.value, winner.value);
    assert.equal(restored.revision, winner.revision);
    const javascript = (await describe()).namespaces.find(row => row.ns === 'weft-javascript')!;
    assert.equal((javascript.value as {enabled: boolean}).enabled, false);
    assert.deepEqual(await a.call('credentials/describe', {refs: ['LOCAL_KEY']}), {LOCAL_KEY: {configured: true, source: 'environment', writable: true}});
    assert.deepEqual(await b.call('credentials/describe', {refs: ['LOCAL_KEY']}), {LOCAL_KEY: {configured: false, writable: true}});
    const stream = await a.stream<WorkspaceFollowFrame>('workspace/follow', {});
    try {
      const baseline = await stream.next();
      assert.equal(baseline.type, 'baseline');
      if (baseline.type !== 'baseline') throw new Error('Missing workspace baseline');
      const workspace = baseline.value.items.find(row => row.workspaceId === project.workspace.workspaceId)!;
      assert.equal(workspace.path, '/workspace/project');
      assert.deepEqual(workspace.sessionIds, ['local-session']);
      assert.deepEqual(baseline.value.pinnedSessionIds, ['local-session']);
    } finally {await stream.close();}
    const presets = await a.call<{presets: unknown[]}>('agentPresets/list', {});
    assert.match(JSON.stringify(presets), /standard/);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('local storage rolls back failed settings and workspace writes and rejects duplicate preset revisions', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, options);
  try {
    const response = await runtime.dispatchFetch(url('alpha', '/_fixture/environment-storage'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({scope: {tenantId: tenantId('alpha'), environmentId: 'default'}, operation: 'atomicity'})});
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      settingsRejected: true, afterFailure: {revision: 1, user: {value: 'before'}}, afterRetry: {revision: 2, user: {value: 'retried'}},
      workspaceRejected: true, stateUnchanged: true, countUnchanged: true, noPartialRow: true,
      first: true, duplicate: false, preset: {revision: 1, value: 'before'},
    });
  } finally {await runtime.dispose();}
});
