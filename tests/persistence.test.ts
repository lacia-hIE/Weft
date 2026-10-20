import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyConfigMigrations, createRuntime, send, type EventRecord, type SessionResponse } from './helpers/miniflare.ts';

async function contractsRuntime(persist?: string): Promise<Miniflare> {
  const options = convertV4MiniflareOptions({
    name: 'contracts', modules: true, scriptPath: resolve('dist/contracts-worker.js'),
    d1Databases: {CONFIG_DB: 'weft-config'},
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    bindings: {MODEL_BACKEND: 'scripted'},
    durableObjects: {
      CONTRACTS: { className: 'ContractsDO', useSQLite: true },
      SESSIONS: { className: 'SessionDO', useSQLite: true },
      WORKSPACES: { className: 'WorkspaceDO', useSQLite: true },
      ENVIRONMENTS: {className: 'EnvironmentDO', useSQLite: true},
      TENANTS: {className: 'TenantDO', useSQLite: true},
    },
  });
  options.workers[0]!.dev = { ...options.workers[0]!.dev, unsafeRegisterWorker: false };
  const runtime = new Miniflare({...options, ...(persist ? {resourcePersistencePath: persist} : {})});
  await applyConfigMigrations(runtime, 'contracts');
  return runtime;
}

test('model upload ownership survives restart, competing publication and stale cleanup without crossing environment or credential boundaries', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-upload-ownership-'));
  let runtime = await contractsRuntime(directory);
  const owner = {tenantId: 'alpha', environmentId: 'one'};
  const scope = 'a'.repeat(64), otherCredential = 'b'.repeat(64);
  const variantId = 'sha256:' + 'c'.repeat(64);
  const candidate = (fileId: string, credential = scope, expiresAt = 10_000) => ({scope: credential, variantId, attachmentId: 'sha256:' + 'd'.repeat(64), fileId, bytes: 100, createdAt: 100, expiresAt});
  const call = async (operation: unknown, address = owner, identity = address) => {
    const response = await runtime.dispatchFetch('http://localhost/model-uploads', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({address, scope: identity, operation})});
    return {status: response.status, ...await response.json() as {value: any; error?: string}};
  };
  const get = (credential = scope, now = 1000) => ({type: 'get', scope: credential, variantId, now, margin: 100});
  const commit = (fileId: string, credential = scope, now = 1000) => ({type: 'commit', candidate: candidate(fileId, credential, now + 9000), now, margin: 100});
  try {
    const race = await Promise.all([call(commit('first')), call(commit('second'))]);
    assert.ok(race.every(result => result.status === 200));
    assert.equal(race.filter(result => result.value.accepted).length, 1);
    const winner = race[0]!.value.record;
    assert.deepEqual(race[1]!.value.record, winner);
    assert.equal((await call(get())).value.fileId, winner.fileId);
    await call(commit('credential-two', otherCredential));
    const environment = {...owner, environmentId: 'two'};
    const tenant = {...owner, tenantId: 'beta'};
    assert.equal((await call(get(), environment)).value, null);
    assert.equal((await call(get(), tenant)).value, null);
    await call(commit('environment-two'), environment);
    await call(commit('tenant-beta'), tenant);
    for (const wrong of [environment, tenant]) {
      const refused = await call({type: 'clear', scope}, owner, wrong);
      assert.equal(refused.status, 400);
      assert.match(refused.error!, /scope mismatch/);
    }
    await runtime.dispose(); runtime = await contractsRuntime(directory);
    assert.deepEqual((await call(get())).value, winner);
    assert.equal((await call(get(otherCredential))).value.fileId, 'credential-two');
    assert.equal((await call(get(), environment)).value.fileId, 'environment-two');
    assert.equal((await call(get(), tenant)).value.fileId, 'tenant-beta');
    // Replacing an expired generation must not let delayed cleanup delete its replacement.
    assert.equal((await call(get(scope, 10_900))).value, null);
    assert.equal((await call(commit('replacement', scope, 10_900))).value.accepted, true);
    await call({type: 'remove', scope, generations: [{variantId, fileId: winner.fileId}]});
    assert.equal((await call(get(scope, 10_900))).value.fileId, 'replacement');
    // Clear only this credential namespace; another environment and tenant retain ownership.
    await call(commit('credential-replacement', otherCredential, 10_900));
    await call({type: 'clear', scope});
    assert.equal((await call(get(scope, 10_900))).value, null);
    assert.equal((await call(get(otherCredential, 10_900))).value.fileId, 'credential-replacement');
    assert.equal((await call(get(), environment)).value.fileId, 'environment-two');
    assert.equal((await call(get(), tenant)).value.fileId, 'tenant-beta');
    const invalid = await call({...commit('invalid'), candidate: {...candidate('invalid'), scope: 'plaintext-api-key'}});
    assert.equal(invalid.status, 400);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('attachment streaming cleans interruptions, bounds staging and rolls back publication without losing verified bytes', async () => {
  const runtime = await contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/attachment-contracts');
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json() as Record<string, unknown>;
    assert.equal(value.wrongScope, 403);
    assert.equal(value.interrupted, 16);
    assert.equal(value.cancelled, true);
    assert.equal(value.stagingLimit, 400);
    assert.deepEqual(value.verified, [0, 255, 1, 2]);
    assert.equal(value.largeBytes, 34 * 1024 * 1024);
    assert.equal(value.largeIntegrity, true);
    assert.equal(value.uploadCalls, 1);
    assert.equal(value.readCalls, 1);
    assert.equal(value.foreign, 'ATTACHMENT_NOT_FOUND');
    assert.equal(value.order, 'ATTACHMENT_WRITE_FAILED');
    assert.equal(value.corrupt, 'ATTACHMENT_CORRUPT');
    assert.equal(value.publication, 'STORAGE_FAILURE');
    assert.deepEqual(value.afterRollback, []);
    assert.equal(value.stagedAfterRollback, 1);
    assert.equal(value.immutable, 'FS_PERMISSION_DENIED');
    assert.equal(value.revision, 1);
  } finally {await runtime.dispose();}
});

test('native plugin context remains parked in the durable Inbox across workerd restart and is consumed by the next prompt', {timeout: 60_000}, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-native-context-'));
  let runtime = await contractsRuntime(directory);
  const read = async (stage: string) => {
    const response = await runtime.dispatchFetch('http://localhost/native-context?stage='+stage);
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as {status: {running: boolean; agentAvailable: boolean}; projections: {values: {inbox: {'next-step': unknown[]; 'next-turn': unknown[]}}}; events: EventRecord[]};
  };
  try {
    const first = await read('seed');
    assert.equal(first.status.running, false);
    assert.equal(first.projections.values.inbox['next-step'].length, 1);
    assert.equal(first.events.filter(record => record.type === 'turn/start').length, 0);
    await runtime.dispose(); runtime = await contractsRuntime(directory);
    const cold = await read('read');
    assert.equal(cold.status.agentAvailable, false);
    assert.equal(cold.projections.values.inbox['next-step'].length, 1);
    const consumed = await read('run');
    assert.deepEqual(consumed.projections.values.inbox, {'next-step': [], 'next-turn': []});
    assert.equal(consumed.events.filter(record => record.type === 'turn/start').length, 1);
    const injected = consumed.events.filter(record => record.type === 'user/message' && JSON.stringify(record.data).includes('cordis-host-runner'));
    assert.equal(injected.length, 1);
    assert.match(JSON.stringify(injected[0]!.data), /Plugin activation context survived/);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('the DO refuses an internal RPC addressed with a different tenant scope', async () => {
  const runtime = await contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/scope');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      wrongScope: 'Session scope does not match the addressed object', wrongEnvironment: 'Session scope does not match the addressed object', correctScopeHasNoEvents: true,
    });
  } finally { await runtime.dispose(); }
});

test('SQLite implements writer ownership, atomic append, visibility, close and format refusal', async () => {
  const runtime = await contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/storage');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      duplicateCreate: 'SessionAlreadyExistsError', duplicateWriter: 'SessionAlreadyOwnedError',
      visibleWhileWriting: 1, readOnlyAppend: 'SessionReadOnlyError', readOnlyFlush: 'SessionReadOnlyError',
      invalidBatch: 'Error', countAfterRefusal: 1, slice: ['turn/end'], listedCount: 1,
      idempotentClose: true, closedRead: 'SessionHandleClosedError', cancelledOpen: 'AbortError',
      staleAppend: 'SessionOwnershipLostError', staleClose: 'SessionOwnershipLostError',
      replacementProtected: 'SessionAlreadyOwnedError', futureVersion: 'SessionFormatUnsupportedError',
      unknownRequiredEvent: 'SessionFormatUnsupportedError',
    });
  } finally { await runtime.dispose(); }
});

test('upstream resume repairs an interrupted tool call without replaying its execution', async () => {
  const source = createRuntime();
  const target = await contractsRuntime();
  try {
    const response = await send(source, 'alpha', 'source', 'Invoke your tool');
    assert.equal(response.status, 200);
    const { events } = await response.json() as SessionResponse;
    const callIndex = events.findIndex(event => event.type === 'tool/call');
    assert.ok(callIndex > 0);
    const prefix = events.slice(0, callIndex + 1);
    const resumed = await target.dispatchFetch('http://localhost/interrupted', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prefix),
    });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const repaired = await resumed.json() as EventRecord[];
    assert.deepEqual(repaired.slice(0, prefix.length), prefix);
    assert.deepEqual(repaired.map(event => event.seq), repaired.map((_event, index) => index));
    assert.equal(repaired[prefix.length]?.type, 'tool/result');
    assert.match(JSON.stringify(repaired[prefix.length]), /unknown|interrupted/i);
    assert.equal(repaired.filter(event => event.type === 'tool/call').length, 2);
    assert.equal(repaired.filter(event => event.type === 'turn/end').length, 2);
    assert.equal(repaired.at(-1)?.data.reason?.kind, 'completed');
  } finally { await Promise.all([source.dispose(), target.dispose()]); }
});

test('Computer scope, symlink confinement, atomic rollback, bytes and workspace format refusal', async () => {
  const runtime = await contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/workspace-contracts');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      wrongScope: 403, symlink: 'FS_SANDBOX_DENIED', rejected: 'FS_IO_ERROR', afterRollback: [], revisionAfterRollback: 1,
      bytes: [255, 65], binary: 'FS_NOT_TEXT', futureFormat: 'Unsupported Weft workspace format',
    });
  } finally { await runtime.dispose(); }
});
