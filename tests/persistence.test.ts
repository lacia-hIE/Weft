import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createRuntime, send, type EventRecord, type SessionResponse } from './helpers/miniflare.ts';

function contractsRuntime(persist?: string): Miniflare {
  const options = convertV4MiniflareOptions({
    modules: true, scriptPath: resolve('dist/contracts-worker.js'),
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
  return new Miniflare({...options, ...(persist ? {resourcePersistencePath: persist} : {})});
}

test('native plugin context remains parked in the durable Inbox across workerd restart and is consumed by the next prompt', {timeout: 60_000}, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weft-native-context-'));
  let runtime = contractsRuntime(directory);
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
    await runtime.dispose(); runtime = contractsRuntime(directory);
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
  const runtime = contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/scope');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      wrongScope: 'Session scope does not match the addressed object', wrongEnvironment: 'Session scope does not match the addressed object', correctScopeHasNoEvents: true,
    });
  } finally { await runtime.dispose(); }
});

test('SQLite implements writer ownership, atomic append, visibility, close and format refusal', async () => {
  const runtime = contractsRuntime();
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
  const target = contractsRuntime();
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
  const runtime = contractsRuntime();
  try {
    const response = await runtime.dispatchFetch('http://localhost/workspace-contracts');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      wrongScope: 403, symlink: 'FS_SANDBOX_DENIED', rejected: 'FS_IO_ERROR', afterRollback: [], revisionAfterRollback: 1,
      bytes: [255, 65], binary: 'FS_NOT_TEXT', futureFormat: 'Unsupported Weft workspace format',
    });
  } finally { await runtime.dispose(); }
});
