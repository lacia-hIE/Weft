import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {JavaScriptRequest, JavaScriptStatus, JavaScriptList} from '../packages/workspace/src/javascript.ts';

test('task catalog survives cold hosts, expires approvals and lost logs, isolates owners and stops work on archive', {timeout: 90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-task-lifecycle-'));
  const options = {browser: true, scriptPath: 'dist/javascript-worker.js'};
  let runtime = createRuntime(directory, options);
  const scope = {tenantId: tenantId('alpha'), environmentId: 'default', workspaceId: 'default'};
  const api = nativeClient(() => runtime);
  const call = async <T = JavaScriptStatus>(operation: JavaScriptRequest, owner = 'lifecycle') => {
    const response = await runtime.dispatchFetch(url('alpha', '/_test/javascript'), {method: 'POST', body: JSON.stringify({scope, owner, operation})});
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as T;
  };
  const start = (owner = 'lifecycle') => call({operation: 'start', source: `import {request} from 'ws:approval'; export default () => request('A retained approval');`, cwd: '/workspace'}, owner);
  const status = async (id: string, expected: string, owner = 'lifecycle') => {
    for (let n = 0; n < 80; n++) {const value = await call({operation: 'status', id}, owner); if (value.status === expected) return value; await delay(25);}
    throw new Error('Task never reached '+expected);
  };
  const maintain = async (id: string, kind: string) => {
    const response = await runtime.dispatchFetch(url('alpha', '/_test/task-maintenance'), {method: 'POST', body: JSON.stringify({scope, id, kind})});
    assert.equal(response.status, 204);
  };
  const base = `/v1/tenants/${scope.tenantId}/environments/default/native/javascript-tasks`;
  try {
    await api.call('session/create', {request: {sessionId: 'lifecycle'}});
    const first = await start(); await status(first.id, 'waiting');
    assert.equal((await call<JavaScriptList>({operation: 'list'}, 'foreign')).tasks.length, 0);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.equal((await call<JavaScriptList>({operation: 'list'})).tasks.find(task => task.id === first.id)?.status, 'waiting');
    const catalog = await runtime.dispatchFetch(url('alpha', base+'?sessionId=lifecycle'));
    assert.equal(catalog.status, 200); assert.equal(catalog.headers.get('cache-control'), 'private, no-store');
    const summary = (await catalog.json() as JavaScriptList).tasks[0]!;
    assert.equal(summary.id, first.id);
    for (const key of ['stdout', 'stderr', 'value']) assert.equal(Object.hasOwn(summary, key), false);
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'?sessionId=foreign'))).status, 404);
    assert.equal((await runtime.dispatchFetch(url('alpha', base), {method: 'POST', headers: {origin: 'https://evil.test', 'content-type': 'application/json'}, body: JSON.stringify({sessionId: 'lifecycle', operation: 'cancelAll'})})).status, 403);
    await maintain(first.id, 'expire');
    const expired = await call({operation: 'status', id: first.id});
    assert.equal(expired.status, 'expired'); assert.equal(expired.error?.code, 'TASK_APPROVAL_EXPIRED');
    const completed = await call({operation: 'start', source: 'export default () => 42;', cwd: '/workspace'});
    await status(completed.id, 'completed'); await maintain(completed.id, 'lose-log');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const lost = await call({operation: 'status', id: completed.id});
    assert.equal(lost.status, 'expired'); assert.equal(lost.error?.code, 'TASK_LOG_EXPIRED');
    const own = await start(); await status(own.id, 'waiting');
    const foreign = await start('foreign'); await status(foreign.id, 'waiting', 'foreign');
    const blocked = await api.raw('workspace/archiveSession', {request: {sessionId: 'lifecycle'}});
    assert.equal(blocked.result.ok, false); assert.equal(blocked.result.error?.code, 'workspace/session-active');
    await api.call('workspace/archiveSession', {request: {sessionId: 'lifecycle', stopActivity: true}});
    assert.equal((await call({operation: 'status', id: own.id})).status, 'cancelled');
    assert.equal((await call({operation: 'status', id: foreign.id}, 'foreign')).status, 'waiting');
    await call({operation: 'cancelAll'}, 'foreign');
    const after = await call<JavaScriptList>({operation: 'list'}, 'foreign');
    assert.ok(after.tasks.every(task => task.status === 'cancelled'));
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
