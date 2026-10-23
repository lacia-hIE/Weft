import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import type {JavaScriptStatus, JavaScriptRequest} from '../packages/workspace/src/javascript.ts';
import type {WorkspaceScope} from '../packages/workspace/src/protocol.ts';

test('Computer JavaScript replays a genuine durable task across a cold host and retains approval without duplicating writes', {timeout: 90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-javascript-'));
  const options = {browser: true, scriptPath: 'dist/javascript-worker.js'};
  let runtime = createRuntime(directory, options);
  const scope: WorkspaceScope = {tenantId: tenantId('alpha'), environmentId: 'default', workspaceId: 'default'};
  const call = async (operation: JavaScriptRequest, owner = 'owner', target = scope, addressScope = target) => {
    const response = await runtime.dispatchFetch(url('alpha', '/_test/javascript'), {method: 'POST', body: JSON.stringify({scope: target, addressScope, owner, operation})});
    return {status: response.status, value: await response.json() as JavaScriptStatus & {error?: string}};
  };
  const until = async (id: string, expected: string) => {
    for (let i = 0; i < 80; i++) {
      const response = await call({operation: 'status', id});
      assert.equal(response.status, 200, JSON.stringify(response.value));
      if (response.value.status === expected) return response.value;
      assert.ok(!['failed', 'cancelled'].includes(response.value.status), JSON.stringify(response.value));
      await delay(25);
    }
    throw new Error('JavaScript task did not reach '+expected);
  };
  try {
    const started = await call({operation: 'start', source: `import fs from 'node:fs/promises'; import {request} from 'ws:approval';
export default async () => {
  let n = 0; try {n = Number(await fs.readFile('/workspace/replay-count.txt', 'utf8'));} catch {}
  await fs.writeFile('/workspace/replay-count.txt', String(n + 1));
  console.log('BEFORE_APPROVAL');
  const answer = await request('Continue the durable data task');
  if (!answer.approved) return {approved: false};
  return {approved: true, count: await fs.readFile('/workspace/replay-count.txt', 'utf8')};
}`, cwd: '/workspace', writable: true, timeoutMs: 3000});
    assert.equal(started.status, 200, JSON.stringify(started.value));
    const id = started.value.id;
    const waiting = await until(id, 'waiting');
    assert.equal(waiting.pending[0]?.reason, 'Continue the durable data task');
    assert.equal((await call({operation: 'status', id}, 'foreign')).status, 400);
    assert.equal((await call({operation: 'status', id}, 'owner', {...scope, tenantId: tenantId('beta')}, scope)).status, 400);
    assert.equal((await call({operation: 'status', id}, 'owner', {...scope, environmentId: 'other'})).status, 400);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    await delay(3200); // Approval waiting is excluded from the execution timeout.
    const restored = await until(id, 'waiting');
    assert.deepEqual(restored.pending, waiting.pending);
    const callId = restored.pending[0]!.callId;
    assert.equal((await call({operation: 'answer', id, callId, approved: true}, 'foreign')).status, 400);
    assert.equal((await call({operation: 'answer', id, callId, approved: true})).status, 200);
    const completed = await until(id, 'completed');
    assert.deepEqual(completed.value, {approved: true, count: '1'});
    assert.equal(completed.stdout.match(/BEFORE_APPROVAL/g)?.length, 1);
    assert.equal((await call({operation: 'answer', id, callId, approved: true})).status, 400);
    const cancelled = await call({operation: 'start', source: `import {request} from 'ws:approval'; export default () => request('Cancel this task');`, cwd: '/workspace', writable: false, timeoutMs: 3000});
    const pending = await until(cancelled.value.id, 'waiting');
    assert.equal((await call({operation: 'cancel', id: pending.id})).value.status, 'cancelled');
    assert.equal((await call({operation: 'answer', id: pending.id, callId: pending.pending[0]!.callId, approved: true})).status, 400);
    const readonly = await call({operation: 'start', source: `import fs from 'node:fs/promises'; export default () => fs.writeFile('/workspace/not-allowed', 'bad');`, cwd: '/workspace', writable: false, timeoutMs: 3000});
    let state = readonly.value;
    for (let i = 0; state.status === 'running' && i < 40; i++) state = (await call({operation: 'status', id: state.id})).value;
    assert.equal(state.status, 'failed');
    const escaped = await call({operation: 'start', source: `import fs from 'node:fs/promises'; export default () => fs.writeFile('/workspace/outside-project.txt', 'bad');`, cwd: '/workspace', root: '/workspace/project', writable: true, timeoutMs: 3000});
    assert.equal(escaped.status, 400, 'a task cannot start outside its approved project root');
    for (const [source, cwd, root] of [
      [`import fs from 'node:fs/promises'; export default () => fs.writeFile('/workspace/outside-project.txt', 'bad');`, '/workspace/project', '/workspace/project'],
      [`import fs from 'node:fs/promises'; export default () => fs.mkdir('/workspace/.weft/private-task', {recursive:true});`, '/workspace', '/workspace'],
    ]) {
      let result = await call({operation: 'start', source: source!, cwd: cwd!, root: root!, writable: true, timeoutMs: 3000});
      assert.equal(result.status, 200, JSON.stringify(result.value));
      for (let i = 0; result.value.status === 'running' && i < 40; i++) result = await call({operation: 'status', id: result.value.id});
      assert.equal(result.value.status, 'failed', 'writable tasks still enforce their project and private-file boundaries');
    }
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
