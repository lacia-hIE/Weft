import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

test('cached plugin code receives fresh facet receipts, revokes old capabilities and isolates supervisors', async () => {
  const options = convertV4MiniflareOptions({modules: true, scriptPath: resolve('dist/dynamic-worker.js'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], workerLoaders: {LOADER: {}}, durableObjects: {NATIVE_PLUGINS: {className: 'NativePluginBench', useSQLite: true}}});
  options.workers[0]!.dev = {...options.workers[0]!.dev, unsafeRegisterWorker: false};
  const runtime = new Miniflare(options);
  const call = async <T>(owner: string, action: string, fields: object = {}): Promise<T> => {
    const response = await runtime.dispatchFetch('http://localhost/native-plugin', {method: 'POST', body: JSON.stringify({owner, action, ...fields})});
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const ids = async (owner = 'alpha') => (await call<{ids: string[]}>(owner, 'workerIds')).ids;
  // Keep a previous run's FS proxy in module state, as an untrusted plugin could do. It must never
  // acquire the new run's authority, even though both runs use the very same cached Worker code.
  const source = `return {apply(ctx){const old=globalThis.previousFs;globalThis.previousFs=ctx.fs;let count=0;harness.handle('read',async()=>{let revoked=false;if(old){try{await old.resolve('old')}catch{revoked=true}}return {current:await ctx.fs.resolve('current'),revoked,count:++count};})}}`;
  type Read = {current: {owner: string; runId: string}; revoked: boolean; count: number};
  try {
    const first = await call<{runId: string}>('alpha', 'start', {source});
    const before = await call<Read>('alpha', 'invoke', {method: 'read'});
    assert.equal(before.current.runId, first.runId);
    assert.equal(before.revoked, false);
    await call('alpha', 'stop');
    const second = await call<{runId: string}>('alpha', 'start', {source});
    assert.notEqual(second.runId, first.runId);
    const after = await call<Read>('alpha', 'invoke', {method: 'read'});
    assert.equal(after.current.runId, second.runId, 'the cached Worker must receive the new facet capability');
    assert.equal(after.revoked, true, 'a retained proxy from the old run remains revoked');
    assert.equal(after.count, 1, 'factory-local plugin state is rebuilt on restart');
    const [firstId, secondId] = await ids();
    assert.equal(firstId, secondId, 'restarting offline plugin code does not allocate another Worker ID');

    await call('beta', 'start', {source});
    const other = await call<Read>('beta', 'invoke', {method: 'read'});
    assert.equal(other.revoked, false, 'another supervisor cannot see the retained module global');
    assert.notEqual(other.current.owner, after.current.owner);
    assert.notEqual((await ids('beta'))[0], firstId, 'identical caller scopes cannot merge owners');
    await call('alpha', 'start', {source: source + '\n// new code'});
    assert.notEqual((await ids()).at(-1), firstId, 'code changes invalidate the identity');

    const module = `export default async function(harness){${source}}`;
    const installed = {module, services: ['fs'], network: false};
    await call('alpha', 'start', {installed});
    const offlineId = (await ids()).at(-1);
    const latest = await call<{runId: string}>('alpha', 'start', {installed});
    assert.equal((await ids()).at(-1), offlineId);
    assert.equal((await call<Read>('alpha', 'invoke', {method: 'read'})).current.runId, latest.runId);
    await call('alpha', 'start', {installed: {...installed, config: {entry: {label: 'changed'}}}});
    assert.notEqual((await ids()).at(-1), offlineId, 'configuration changes invalidate the identity');
    await call('alpha', 'start', {installed: {...installed, services: ['fs', 'timer']}});
    assert.notEqual((await ids()).at(-1), offlineId, 'permission changes invalidate the identity');

    const online = {...installed, network: true};
    await call('alpha', 'start', {installed: online});
    const onlineId = (await ids()).at(-1);
    await call('alpha', 'start', {installed: online});
    assert.notEqual((await ids()).at(-1), onlineId, 'run-bound network egress must not retain an old receipt');
    const environment = {...online, environment: true, activationId: 'approved-activation'};
    await call('alpha', 'start', {installed: environment});
    const environmentId = (await ids()).at(-1);
    await call('alpha', 'start', {installed: environment});
    assert.equal((await ids()).at(-1), environmentId, 'environment egress retains its stable activation identity');
    await call('alpha', 'start', {installed: {...environment, activationId: 'new-activation'}});
    assert.notEqual((await ids()).at(-1), environmentId, 'changing the egress activation must invalidate the identity');
  } finally {await runtime.dispose();}
});
