import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observedLoader, observationScope, type WorkerObservationProps} from '../packages/dynamic-worker-observability/src/loader.ts';

test('observation preserves capabilities, stable get identities and distinct load observations', async () => {
  const captures: WorkerObservationProps[] = [], ids: (string | null)[] = [], loaded: WorkerLoaderWorkerCode[] = [];
  const cached = new Map<string, Promise<WorkerLoaderWorkerCode>>();
  const stub = {} as WorkerStub, host = {} as Fetcher, previous = {} as Fetcher;
  const raw: WorkerLoader = {
    get(id, callback) {ids.push(id); if (!cached.has(id!)) cached.set(id!, Promise.resolve(callback())); return stub;},
    load(code) {loaded.push(code); return stub;},
  };
  const code: WorkerLoaderWorkerCode = {compatibilityDate: '2026-07-30', mainModule: 'main.js', modules: {'main.js': 'export default {}'},
    env: {HOST: host, PASSWORD: 'not-a-label'}, globalOutbound: null, limits: {cpuMs: 100}, tails: [previous]};
  const ctx = {exports: {DynamicWorkerTail({props}: {props: WorkerObservationProps}) {captures.push(props); return host;}}};
  const scope = {tenantId: 'alice', environmentId: 'work', sessionId: 's1', authorization: 'SECRET'};
  const loader = observedLoader(raw, ctx, () => observationScope(scope, 'plugin', {pluginId: 'example'}))!;
  let factories = 0;
  assert.equal(loader.get('stable', () => {factories++; return code;}), stub);
  loader.get('stable', () => {factories++; return code;});
  const attached = await cached.get(ids[0]!)!;
  assert.equal(factories, 1); assert.equal(ids[0], ids[1]);
  assert.equal(attached.modules, code.modules); assert.equal(attached.env, code.env); assert.equal(attached.globalOutbound, null);
  assert.equal(attached.limits, code.limits); assert.deepEqual(attached.tails, [previous, host]);
  assert.equal(captures[0]!.workerId, ids[0]); assert.equal(captures[0]!.tenantId, 'alice');
  assert.equal(JSON.stringify(captures).includes('SECRET'), false); assert.equal(JSON.stringify(captures).includes('not-a-label'), false);
  loader.load(code); loader.load(code);
  assert.notEqual(captures[1]!.workerId, captures[2]!.workerId);
  assert.equal(captures[0]!.codeHash, captures[1]!.codeHash);
  assert.equal(loaded.length, 2); assert.equal(code.tails?.length, 1, 'the underlying WorkerCode is never mutated');
  const other = observedLoader(raw, ctx, () => observationScope({...scope, tenantId: 'bob'}, 'plugin', {pluginId: 'example'}))!;
  other.get('stable', () => code); await cached.get(ids[2]!)!;
  assert.notEqual(ids[0], ids[2], 'an observation binding never reuses another tenant attribution');
});

test('cached definitions capture immutable labels and unavailable collectors preserve the loader', async () => {
  const code: WorkerLoaderWorkerCode = {compatibilityDate: '2026-07-30', mainModule: 'main.js', modules: {'main.js': ''}};
  let build: (() => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) | undefined;
  const raw: WorkerLoader = {get(_id, callback) {build = callback; return {} as WorkerStub;}, load: () => ({} as WorkerStub)};
  assert.equal(observedLoader(raw, {exports: {}}, () => ({kind: 'ptc'})), raw);
  assert.equal(observedLoader(undefined, {exports: {}}, () => ({kind: 'ptc'})), undefined);
  let environmentId = 'first';
  const captures: WorkerObservationProps[] = [];
  const ctx = {exports: {DynamicWorkerTail({props}: {props: WorkerObservationProps}) {captures.push(props); return {} as Fetcher;}}};
  observedLoader(raw, ctx, () => ({kind: 'workspace-shell', tenantId: 'alice', environmentId}))!.get('shell', () => code);
  environmentId = 'second'; await build!();
  assert.equal(captures[0]!.environmentId, 'first');
});
