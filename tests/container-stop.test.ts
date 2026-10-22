import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {ContainerAdmission} from '../packages/workspace/src/container-admission.ts';

function sqlStorage(db: DatabaseSync): SqlStorage {
  return {exec(query: string, ...bindings: (string | number | null)[]) {
    const rows = db.prepare(query).all(...bindings);
    return {toArray: () => rows, one: () => {assert.equal(rows.length, 1); return rows[0];}, [Symbol.iterator]: () => rows[Symbol.iterator]()};
  }} as unknown as SqlStorage;
}

test('container admission survives object rebuilds and fences old connections after repeated stops', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = sqlStorage(db);
    const admission = new ContainerAdmission(sql);
    const old = admission.epoch;
    admission.assert(old);
    const stop = admission.begin();
    assert.equal(admission.begin(), stop, 'a resumed stop keeps the same operation identity');
    assert.throws(() => admission.assert(), /stopping/);
    const restored = new ContainerAdmission(sql);
    assert.equal(restored.stopping, true);
    restored.finish(stop);
    assert.throws(() => restored.assert(old), /connection has ended/);
    restored.assert();
    const next = restored.begin();
    restored.finish(stop);
    assert.equal(restored.stopping, true, 'an old completion cannot release a newer stop');
    restored.finish(next);
  } finally {db.close();}
});

test('workspace stop coalesces requests, gates new connections, syncs before destroy and preserves a container on sync failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-container-stop-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const bundle = join(directory, 'host', 'host.mjs');
    await build({entryPoints: ['tests/fixtures/container-stop-host.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error',
      plugins: [{name: 'container-lifecycle-test', setup(builder) {
        builder.onResolve({filter: /^cloudflare:workers$/}, () => ({path: 'base', namespace: 'cloudflare-test'}));
        builder.onLoad({filter: /.*/, namespace: 'cloudflare-test'}, () => ({contents: "export {RpcTarget} from 'capnweb'; export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}", resolveDir: process.cwd()}));
      }}]});
    const host = await import(pathToFileURL(bundle).href) as typeof import('./fixtures/container-stop-host.ts');
    const scope = {tenantId: 'tenant-test', environmentId: 'test', workspaceId: 'default'};
    const make = (options: {running?: boolean; syncFails?: boolean; pause?: Promise<void>} = {}) => {
      const calls: string[] = [];
      const db = new DatabaseSync(':memory:');
      const kv = new Map<string, unknown>();
      const sql = sqlStorage(db);
      const storage = {sql, transactionSync: <T>(callback: () => T) => callback(), sync: async () => {},
        get: async (key: string) => kv.get(key), put: async (key: string, value: unknown) => {kv.set(key, value);}, delete: async (key: string) => kv.delete(key)};
      const container = {running: options.running ?? true, destroy: async () => {calls.push('destroy'); container.running = false;}};
      const containerHost = new host.WorkspaceContainerBasicDO({storage, container} as never, {});
      const state = {storage, id: {toString: () => host.workspaceAddress(scope), equals: (id: string) => id === host.workspaceAddress(scope)},
        exports: Object.fromEntries(['WorkspaceContainerBasicDO', 'WorkspaceContainerStandard1DO', 'WorkspaceContainerStandard2DO'].map(name => [name, {getByName: () => containerHost}])),
        waitUntil: (_promise: Promise<unknown>) => {}};
      const workspace = new host.WorkspaceDO(state as never, {WORKSPACES: {idFromName: (id: string) => id}, SESSIONS: {getByName: () => ({nativeStopContainerProcesses: async () => {calls.push('cancel'); await options.pause;}})}} as never);
      Reflect.set(workspace, 'files', {synchronize: async () => {calls.push('sync'); if (options.syncFails) throw new Error('file sync refused'); return [];}});
      Reflect.set(workspace, 'containerConnection', {close: async () => {calls.push('close');}, closed: Promise.resolve()});
      return {workspace, containerHost, container, calls, db};
    };
    await t.test('shared stop and lifecycle gate', async () => {
      const paused = Promise.withResolvers<void>();
      const {workspace, containerHost, container, calls, db} = make({pause: paused.promise});
      try {
        const first = workspace.stopContainer(scope, ['a', 'b']);
        const second = workspace.stopContainer(scope, ['a', 'b']);
        while (!calls.includes('cancel')) await new Promise(resolve => setTimeout(resolve, 0));
        await assert.rejects(containerHost.start({env: {}, enableInternet: true}), /stopping/);
        const connection = await workspace.fetch(new Request('https://workspace.internal/weft/process', {headers: {upgrade: 'websocket', 'x-weft-workspace': JSON.stringify(scope), 'x-weft-container-instance': 'basic'}}));
        assert.equal(connection.status, 409);
        paused.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200); assert.equal(b.status, 200);
        assert.deepEqual(await a.json(), await b.json());
        assert.equal(container.running, false);
        assert.deepEqual(calls, ['cancel', 'cancel', 'sync', 'destroy', 'close']);
        assert.equal((await workspace.containerState(scope)).status, 'stopped');
        const stale = await workspace.fetch(new Request('https://workspace.internal/weft/process', {headers: {upgrade: 'websocket', 'x-weft-workspace': JSON.stringify(scope), 'x-weft-container-instance': 'basic', 'x-weft-container-epoch': '0'}}));
        assert.equal(stale.status, 409, 'old reconnects cannot start the stopped container');
        const third = await workspace.stopContainer(scope, []);
        assert.equal(third.status, 200);
        assert.equal(calls.filter(call => call === 'sync').length, 1, 'stopping an already stopped container never wakes it for sync');
      } finally {db.close();}
    });
    await t.test('sync failure preserves the container and releases admission for retry', async () => {
      const {workspace, container, calls, db} = make({syncFails: true});
      try {
        const response = await workspace.stopContainer(scope, ['a']);
        assert.equal(response.status, 409);
        assert.match(await response.text(), /file sync refused/);
        assert.equal(container.running, true);
        assert.deepEqual(calls, ['cancel', 'sync']);
        assert.equal((await workspace.containerState(scope)).status, 'running');
        assert.throws(() => workspace.stopContainer({...scope, tenantId: 'another-tenant'}, []), /scope mismatch/);
      } finally {db.close();}
    });
  } finally {await rm(directory, {recursive: true, force: true});}
});
