import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {SettingsDescribeValue, SettingsNamespaceView} from '@deepseek-ai/dsh-settings/types';
import type {SessionListValue} from '@deepseek-ai/dsh-api-session-controller/types';

const options = {browser: true, configureModel: false, scriptPath: 'dist/environment-storage-worker.js'};
const owner = {tenantId: tenantId('alpha'), environmentId: 'default'};

test('a multi-entry configuration document rolls back on a storage fault and retries the same file version', {timeout: 120_000}, async () => {
  const runtime = createRuntime(undefined, options), api = nativeClient(() => runtime);
  const fixture = async (operation: string) => {
    const response = await runtime.dispatchFetch(url('alpha', '/_fixture/environment-storage'), {method: 'POST', body: JSON.stringify({scope: owner, operation})});
    assert.equal(response.status, 200);
  };
  const fileUrl = url('alpha', `/v1/tenants/${owner.tenantId}/environments/default/workspaces/default/files`);
  const read = async (path: string) => {
    const response = await runtime.dispatchFetch(fileUrl+'?path='+encodeURIComponent(path));
    assert.equal(response.status, 200);
    return (await response.json() as {value: {version: string; content: string}}).value;
  };
  const describe = () => api.call<SettingsDescribeValue>('settings/describe', {});
  const value = (rows: SettingsDescribeValue, id: string) => rows.namespaces.find(row => row.ns === id)!;
  try {
    await api.call('settings/update', {ns: 'weft-documents', patch: {previewCharacters: 100}});
    await api.call('settings/update', {ns: 'agent-loop', patch: {maxParallelToolCalls: 3}});
    await api.call('settings/openSettingsDocument', {});
    const before = await describe(), document = await read('/workspace/.dsh/profile.yml');
    await fixture('fail-document');
    const response = await runtime.dispatchFetch(fileUrl, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: '/workspace/.dsh/profile.yml', expectedVersion: document.version, content: '- id: weft-documents\n  config:\n    previewCharacters: 200\n- id: agent-loop\n  config:\n    maxParallelToolCalls: 5\n'})});
    assert.equal(response.status, 200);
    const rejected = await describe();
    for (const id of ['agent-loop', 'weft-documents']) assert.deepEqual(value(rejected, id), value(before, id), 'no partial value, revision or native form update');
    assert.match((await read('/workspace/.dsh/profile.error.txt')).content, /injected document failure/);
    const fileVersion = (await read('/workspace/.dsh/profile.yml')).version;
    await fixture('allow-document');
    const retried = await describe();
    assert.equal((value(retried, 'agent-loop').value as {maxParallelToolCalls: number}).maxParallelToolCalls, 5);
    assert.equal((value(retried, 'weft-documents').value as {previewCharacters: number}).previewCharacters, 200);
    assert.equal(value(retried, 'weft-documents').revision, value(before, 'weft-documents').revision+1);
    assert.equal((await read('/workspace/.dsh/profile.yml')).version, fileVersion, 'retry needs no new file edit');
    assert.equal((await read('/workspace/.dsh/profile.error.txt')).content, '');
    assert.deepEqual(await describe(), retried, 'applied file is not committed twice');
  } finally {await runtime.dispose();}
});

test('completed session lists use a rebuildable local summary index across restart and report latency baselines', {timeout: 180_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-services-'));
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime), ids = Array.from({length: 12}, (_, index) => `summary-${index}`);
  const counts = () => Promise.all(ids.map(async sessionId => {
    const response = await runtime.dispatchFetch(url('alpha', '/_fixture/summary-reads'), {method: 'POST', body: JSON.stringify({...owner, sessionId})});
    assert.equal(response.status, 200);
    return (await response.json() as {reads: number}).reads;
  }));
  const measure = async <T>(operation: () => Promise<T>) => {const start=performance.now(); const value=await operation(); return {value, ms: performance.now()-start};};
  const stats = (samples: number[]) => {const sorted=[...samples].sort((a,b)=>a-b); return {samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1]};};
  try {
    for (const sessionId of ids) await api.call('session/create', {request: {sessionId}});
    const before = await counts();
    const warm: number[] = [];
    for (let index=0;index<8;index++) {
      const sample=await measure(()=>api.call<SessionListValue>('session/list', {}));
      assert.equal(sample.value.items.length, ids.length); warm.push(sample.ms);
    }
    assert.deepEqual(await counts(), before, 'warm completed lists issue no per-session summary RPCs');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const cold = await measure(()=>api.call<SessionListValue>('session/list', {}));
    assert.equal(cold.value.items.length, ids.length);
    assert.deepEqual(await counts(), before, 'a cold EnvironmentDO reads its persisted derived index');
    await runtime.dispatchFetch(url('alpha', '/_fixture/environment-storage'), {method: 'POST', body: JSON.stringify({scope: owner, operation: 'clear-summaries'})});
    const rebuilt = await api.call<SessionListValue>('session/list', {});
    assert.deepEqual(rebuilt, cold.value);
    assert.deepEqual(await counts(), before.map(value=>value+1), 'missing summaries rebuild once from authoritative logs');
    await api.call('session/rename', {request: {sessionId: ids[0]!, title: 'Updated source title'}});
    assert.match(JSON.stringify((await api.call<SessionListValue>('session/list', {})).items.find(row=>row.sessionId===ids[0])), /Updated source title/);
    const settings: number[] = [];
    for (let index=0;index<5;index++) settings.push((await measure(()=>api.call('settings/describe', {}))).ms);
    const admission: number[] = [];
    for (let index=0;index<3;index++) {
      admission.push((await measure(()=>api.call('session/prompt', {request: {sessionId: ids[0]!, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Report your tenant identity'}]}}))).ms);
      const drained = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${owner.tenantId}/environments/default/sessions/${ids[0]}/events`));
      assert.equal(drained.status, 200);
    }
    console.log('WEFT_PERFORMANCE '+JSON.stringify({sessionListWarm:stats(warm),sessionListColdMs:cold.ms,settingsWarm:stats(settings),promptAdmission:stats(admission),completedListSourceRpcs:0}));
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
