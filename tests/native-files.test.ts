import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {createWebConnectionRpc} from '@weft/upstream/packages/client/connection/src/client/rpc.ts';
import type {WorkspaceFileText, WorkspaceFileBytes, WorkspaceDirectoryListing, WorkspaceFileWatchFrame} from '@deepseek-ai/dsh-api-workspace-files/types';

const base = (environment = 'default', user: 'alpha' | 'beta' = 'alpha') => `/v1/tenants/${tenantId(user)}/environments/${environment}`;
function write(runtime: ReturnType<typeof createRuntime>, path: string, content: string, expectedVersion: string | null = null, environment = 'default', user: 'alpha' | 'beta' = 'alpha') {
  return runtime.dispatchFetch(url(user, base(environment, user)+'/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path, content, expectedVersion})});
}

test('original WorkspaceFiles pages UTF-8, lists directories and returns byte attachments decoded by the original Connection caller', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const rpc = createWebConnectionRpc(async (route, init) => {
    const response = await runtime.dispatchFetch(url('alpha', base()+'/native/'+route), init as never);
    return new Response(await response.arrayBuffer(), {status: response.status, headers: Object.fromEntries(response.headers)});
  });
  try {
    await api.call('session/create', {request: {sessionId: 'files'}});
    // The emoji straddles the provider's byte chunk boundary.
    const content = 'x'.repeat(16_383)+'🙂\n第二行\nlast';
    assert.equal((await write(runtime, 'docs/notes.txt', content)).status, 200);
    assert.equal((await write(runtime, 'empty.txt', '')).status, 200);
    const list = await api.call<WorkspaceDirectoryListing>('workspaceFiles/list', {workspaceFileScopeId: 'files', path: '.'});
    assert.deepEqual(list, {path: '', entries: [{name: 'docs', type: 'directory', size: 0}, {name: 'empty.txt', type: 'file', size: 0}], truncated: false});
    const page = await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'files', path: 'docs/notes.txt', range: {offset: 2, limit: 1}});
    assert.equal(page.text, '第二行'); assert.equal(page.lines, 1); assert.equal(page.eof, false);
    const all = await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'files', path: 'docs/notes.txt', range: {}});
    assert.equal(all.text, content); assert.equal(all.eof, true);
    const bytes = await rpc.call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'files', path: 'notes.txt', options: {baseFile: 'docs/notes.txt'}}});
    assert.equal(bytes.ok, true, JSON.stringify(bytes));
    if (bytes.ok) {
      const value = bytes.value as WorkspaceFileBytes;
      assert.ok(value.data instanceof Uint8Array);
      assert.deepEqual(value.data, new TextEncoder().encode(content));
      assert.equal(value.absolutePath, '/workspace/docs/notes.txt');
      assert.equal(value.bytes, new TextEncoder().encode(content).length);
    }
    const range = await rpc.call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'files', path: 'docs/notes.txt', options: {range: {offset: 16_383, length: 4}}}});
    assert.ok(range.ok);
    assert.deepEqual((range.value as WorkspaceFileBytes).data, new TextEncoder().encode('🙂'));
    const empty = await rpc.call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'files', path: 'empty.txt', options: {}}});
    assert.ok(empty.ok); assert.equal((empty.value as WorkspaceFileBytes).data.byteLength, 0);
  } finally {await runtime.dispose();}
});

test('file lookups enforce session ownership, environment volumes, project directory containment and native error contracts', async () => {
  const runtime = createRuntime();
  const api = nativeClient(() => runtime);
  const other = nativeClient(() => runtime, 'other');
  try {
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})});
    await api.call('session/create', {request: {sessionId: 'same'}});
    await other.call('session/create', {request: {sessionId: 'same'}});
    assert.equal((await write(runtime, 'note.txt', 'first volume')).status, 200);
    assert.equal((await write(runtime, 'note.txt', 'second volume', null, 'other')).status, 200);
    for (const [client, text] of [[api, 'first volume'], [other, 'second volume']] as const) {
      assert.equal((await client.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'same', path: 'note.txt', range: {}})).text, text);
    }
    assert.equal((await nativeClient(() => runtime, 'default', 'beta').raw('workspaceFiles/stat', {workspaceFileScopeId: 'same', path: 'note.txt'})).result.error?.code, 'session/not-found');
    for (const path of ['/etc/passwd', '/workspace/../../secret', '../secret']) {
      assert.equal((await api.raw('workspaceFiles/stat', {workspaceFileScopeId: 'same', path})).result.error?.code, 'workspace-file/outside-workspace');
    }
    assert.equal((await api.raw('workspaceFiles/read', {workspaceFileScopeId: 'same', path: '.', range: {}})).result.error?.code, 'workspace-file/not-regular-file');
    assert.equal((await api.raw('workspaceFiles/stat', {workspaceFileScopeId: 'same', path: 'missing'})).result.error?.code, 'workspace-file/not-found');
    assert.equal((await api.raw('workspaceFiles/read', {workspaceFileScopeId: 'same', path: 'note.txt', range: {limit: 5001}})).result.error?.code, 'gateway/bad-request');
    assert.equal((await api.raw('workspaceFiles/readBytes', {workspaceFileScopeId: 'same', path: 'note.txt', options: {range: {length: 2_097_153}}})).result.error?.code, 'workspace-file/too-large');
    assert.equal((await api.raw('workspaceFiles/stat', {workspaceFileScopeId: 'same', path: 'note.txt', tenantId: tenantId('beta')})).result.error?.code, 'gateway/bad-request');
    await api.call('workspace/initializeDefault', {});
    const path = await api.call<string>('directoryPicker/createDirectory', {path: '/workspace', name: 'project'});
    const project = await api.call<{workspace: {workspaceId: string}}>('workspace/create', {request: {path}});
    await api.call('session/create', {request: {sessionId: 'project', workspaceId: project.workspace.workspaceId}});
    assert.equal((await write(runtime, 'project/inside.txt', 'project bytes')).status, 200);
    assert.equal((await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'project', path: 'inside.txt', range: {}})).text, 'project bytes');
    assert.equal((await api.raw('workspaceFiles/list', {workspaceFileScopeId: 'project', path: '..'})).result.error?.code, 'workspace-file/outside-workspace');
    // Original previews permit readable files outside cwd, still within this environment's volume.
    assert.equal((await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'project', path: '../note.txt', range: {}})).text, 'first volume');
  } finally {await runtime.dispose();}
});

test('real WorkspaceDO invalidations refresh original file and directory feeds, and repeated cancellation releases observers', async () => {
  const runtime = createRuntime();
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'watch'}});
    assert.equal((await write(runtime, 'note.txt', 'before')).status, 200);
    const directory = await api.stream<WorkspaceFileWatchFrame>('workspaceFiles/changes', {workspaceFileScopeId: 'watch', path: '.'});
    const file = await api.stream<WorkspaceFileWatchFrame>('workspaceFiles/changes', {workspaceFileScopeId: 'watch', path: 'note.txt'});
    try {
      assert.deepEqual(await directory.next(), {kind: 'ready'});
      assert.deepEqual(await file.next(), {kind: 'ready'});
      const cancellation = {observerId: file.observerId, sessionId: 'watch'};
      const cancelPath = base()+'/native/file-observers/cancel';
      assert.equal((await runtime.dispatchFetch(url('beta', cancelPath), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(cancellation)})).status, 403);
      assert.equal((await runtime.dispatchFetch(url('alpha', cancelPath), {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://another.example'}, body: JSON.stringify(cancellation)})).status, 403);
      assert.equal((await runtime.dispatchFetch(url('alpha', cancelPath), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...cancellation, sessionId: 'different-session'})})).status, 204);
      assert.equal((await write(runtime, 'note.txt', 'after', '1')).status, 200);
      const changed = await file.next();
      assert.deepEqual(changed, {kind: 'change', change: {absolutePath: '/workspace/note.txt', version: '2'}});
      assert.equal((await directory.next()).kind, 'change');
      assert.equal((await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'watch', path: 'note.txt', range: {}})).text, 'after');
    } finally {await Promise.all([directory.close(), file.close()]);}
    for (let i = 0; i < 35; i++) {
      const observer = await api.stream<WorkspaceFileWatchFrame>('workspaceFiles/changes', {workspaceFileScopeId: 'watch', path: '.'});
      assert.deepEqual(await observer.next(), {kind: 'ready'});
      await observer.close();
    }
    const observerId = crypto.randomUUID();
    const cancelPath = base()+'/native/file-observers/cancel';
    assert.equal((await runtime.dispatchFetch(url('alpha', cancelPath), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId: 'watch', observerId})})).status, 204);
    const cancelled = await runtime.dispatchFetch(url('alpha', base()+'/native/streams/workspaceFiles/changes'), {method: 'POST', headers: {'content-type': 'application/json', 'x-weft-observer-id': observerId}, body: JSON.stringify({args: {workspaceFileScopeId: 'watch', path: '.'}})});
    assert.equal((await cancelled.json() as {result: {error: {code: string}}}).result.error.code, 'gateway/bad-request');
  } finally {await runtime.dispose();}
});

test('native file previews remain available after workerd restart without activating an Agent writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-files-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'restart'}});
    assert.equal((await write(runtime, 'saved.txt', 'durable file')).status, 200);
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    assert.equal((await api.call<WorkspaceFileText>('workspaceFiles/read', {workspaceFileScopeId: 'restart', path: 'saved.txt', range: {}})).text, 'durable file');
    const projections = await api.call<{values: {workingDirectory: string}}>('session/projections', {request: {sessionId: 'restart'}});
    assert.equal(projections.values.workingDirectory, '/workspace');
    await api.call('session/prompt', {request: {sessionId: 'restart', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'A normal turn after preview'}]}});
    const events = await (await runtime.dispatchFetch(url('alpha', base()+'/sessions/restart/events'))).json();
    assert.ok(JSON.stringify(events).includes('completed'));
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('the original directory cap reports truncation beyond 2000 real Computer entries', {timeout: 120_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'large-directory'}});
    for (let start = 0; start <= 2000; start += 32) {
      const count = Math.min(32, 2001 - start);
      const writes = await Promise.all(Array.from({length: count}, (_, offset) => write(runtime, 'many/file-'+String(start+offset).padStart(4, '0')+'.txt', '')));
      assert.ok(writes.every(response => response.status === 200));
    }
    const listing = await api.call<WorkspaceDirectoryListing>('workspaceFiles/list', {workspaceFileScopeId: 'large-directory', path: 'many'});
    assert.equal(listing.entries.length, 2000);
    assert.equal(listing.truncated, true);
    assert.equal(listing.entries.at(-1)?.name, 'file-1999.txt');
    const last = await api.call<{absolutePath: string}>('workspaceFiles/stat', {workspaceFileScopeId: 'large-directory', path: 'many/file-2000.txt'});
    assert.equal(last.absolutePath, '/workspace/many/file-2000.txt');
  } finally {await runtime.dispose();}
});
