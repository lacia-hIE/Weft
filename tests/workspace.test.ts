import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Response } from 'miniflare';
import { createRuntime, tenantId, url, sessionPath, type User, type SessionResponse } from './helpers/miniflare.ts';

function endpoint(user: User, workspace: string, action = 'files'): string { return url(user, `/v1/tenants/${tenantId(user)}/workspaces/${workspace}/${action}`); }
function read(runtime: ReturnType<typeof createRuntime>, user: User, workspace: string, path = '/workspace') {
  return runtime.dispatchFetch(endpoint(user, workspace) + '?path=' + encodeURIComponent(path));
}
function write(runtime: ReturnType<typeof createRuntime>, user: User, workspace: string, path: string, content: string, expectedVersion: string | null = null) {
  return runtime.dispatchFetch(endpoint(user, workspace), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, expectedVersion }) });
}
async function value<T>(response: globalThis.Response | Awaited<ReturnType<ReturnType<typeof createRuntime>['dispatchFetch']>>): Promise<T> {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { value: T }).value;
}
function message(runtime: ReturnType<typeof createRuntime>, session: string, workspaceId?: string) {
  return runtime.dispatchFetch(url('alpha', sessionPath('alpha', session, 'messages')), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Use the workspace tools', ...(workspaceId ? { workspaceId } : {}) }),
  });
}
function event(type: string, data: Record<string, unknown> = {}): string { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }
function modelReply(name?: string, args: object = {}): Response {
  const block = name ? { type: 'tool_use', id: 'call_' + crypto.randomUUID(), name, input: {} } : { type: 'text', text: '' };
  let body = event('message_start', { message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    + event('content_block_start', { index: 0, content_block: block });
  body += event('content_block_delta', { index: 0, delta: name ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: 'Workspace operation complete' } });
  body += event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } }) + event('message_stop');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
const realAdapter = { MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'fake-workspace-test-key', DEEPSEEK_BASE_URL: 'https://model.test/anthropic' };

test('Computer files, listings and literal search are isolated by tenant and workspace', async () => {
  const runtime = createRuntime();
  try {
    for (const [user, workspace, content] of [['alpha', 'one', 'alpha needle'], ['beta', 'one', 'beta needle'], ['alpha', 'two', 'other needle']] as const) {
      const result = await value<{ version: string; revision: number }>(await write(runtime, user, workspace, 'notes/test.txt', content));
      assert.equal(result.version, '1');
      assert.equal(result.revision, 1);
      const file = await value<{ content: string }>(await read(runtime, user, workspace, '/workspace/notes/test.txt'));
      assert.equal(file.content, content);
      const list = await value<{ path: string }[]>(await read(runtime, user, workspace));
      assert.deepEqual(list.map(entry => entry.path), ['/workspace/notes']);
      const resultSearch = await value<{ matches: { text: string }[] }>(await runtime.dispatchFetch(endpoint(user, workspace, 'search') + '?query=needle'));
      assert.deepEqual(resultSearch.matches.map(match => match.text), [content]);
    }
    const attack = await runtime.dispatchFetch(url('beta', `/v1/tenants/${tenantId('alpha')}/workspaces/one/files`));
    assert.equal(attack.status, 403);
    assert.equal((await runtime.dispatchFetch(url('anonymous', `/v1/tenants/${tenantId('alpha')}/workspaces/one/files`))).status, 401);
  } finally { await runtime.dispose(); }
});

test('guarded writes serialize races, reject stale versions and advance revisions even for identical bytes', async () => {
  const runtime = createRuntime();
  try {
    await value(await write(runtime, 'alpha', 'race', 'note.txt', 'base'));
    const responses = await Promise.all([
      write(runtime, 'alpha', 'race', 'note.txt', 'left', '1'), write(runtime, 'alpha', 'race', 'note.txt', 'right', '1'),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const before = await value<{ content: string; version: string }>(await read(runtime, 'alpha', 'race', 'note.txt'));
    const unchanged = await value<{ revision: number }>(await write(runtime, 'alpha', 'race', 'note.txt', before.content, before.version));
    assert.equal(unchanged.revision, 3);
    assert.equal((await write(runtime, 'alpha', 'race', 'note.txt', 'stale', before.version)).status, 409);
    assert.equal((await write(runtime, 'alpha', 'race', 'note.txt', 'blind replacement')).status, 409);
    assert.equal((await value<{ content: string }>(await read(runtime, 'alpha', 'race', 'note.txt'))).content, before.content);
  } finally { await runtime.dispose(); }
});

test('paths, input sizes and cross-origin file writes are checked before mutation', async () => {
  const runtime = createRuntime();
  try {
    for (const path of ['/etc/secrets', '../escape', '/workspace/../../escape', '/workspace/a\\b', '/workspace/zero\0byte']) {
      assert.equal((await write(runtime, 'alpha', 'paths', path, 'bad')).status, 403, path);
    }
    const crossOrigin = await runtime.dispatchFetch(endpoint('alpha', 'paths'), {
      method: 'PUT', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x', content: 'bad', expectedVersion: null }),
    });
    assert.equal(crossOrigin.status, 403);
    const oversized = await write(runtime, 'alpha', 'paths', 'large.txt', '中'.repeat(100000));
    assert.equal(oversized.status, 413);
    const invalid = await runtime.dispatchFetch(endpoint('alpha', 'paths'), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x', content: 'missing guard' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await write(runtime, 'alpha', 'paths', 'binary.txt', 'x\0y')).status, 400);
    assert.deepEqual(await value(await read(runtime, 'alpha', 'paths')), []);
  } finally { await runtime.dispose(); }
});

test('literal edits reject ambiguity and stale guards without changing bytes or revision', async () => {
  const runtime = createRuntime();
  const patch = (oldString: string, newString: string, expectedVersion: string, replaceAll = false) => runtime.dispatchFetch(endpoint('alpha', 'edits'), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'note.txt', oldString, newString, expectedVersion, replaceAll }),
  });
  try {
    await value(await write(runtime, 'alpha', 'edits', 'note.txt', 'same\r\nsame\r\n'));
    assert.equal((await patch('same', 'changed', '1')).status, 409);
    assert.equal((await patch('absent', 'x', '1')).status, 400);
    const result = await value<{ revision: number; after: string }>(await patch('same', 'changed', '1', true));
    assert.equal(result.revision, 2);
    assert.equal(result.after, 'changed\nchanged\n');
    assert.equal((await patch('changed', 'stale', '1', true)).status, 409);
    assert.equal((await value<{ version: string }>(await read(runtime, 'alpha', 'edits', 'note.txt'))).version, '2');
  } finally { await runtime.dispose(); }
});

test('native Harness write/read/edit and observation policy operate against the Computer WorkspaceDO', async () => {
  const script: [string | undefined, object][] = [
    ['write', { file_path: 'notes/test.txt', content: 'hello\nneedle' }],
    ['read', { file_path: 'notes/test.txt' }],
    ['edit', { file_path: 'notes/test.txt', old_string: 'hello', new_string: 'updated' }],
    ['read', { file_path: 'notes/test.txt' }],
    ['workspace_search', { query: 'updated' }],
    [undefined, {}],
  ];
  const calls: string[] = [];
  const runtime = createRuntime(undefined, { bindings: realAdapter, outbound: async request => {
    const raw = await request.text(); calls.push(raw);
    const body = JSON.parse(raw) as { tools: { name: string }[] };
    for (const name of ['read', 'write', 'edit', 'workspace_search']) assert.ok(body.tools.some(tool => tool.name === name));
    const step = script[calls.length - 1] ?? (calls.length === 7 ? ['read', { file_path: 'notes/test.txt' }] : [undefined, {}]);
    return modelReply(step[0], step[1]);
  } });
  try {
    const response = await message(runtime, 'native', 'shared');
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json() as SessionResponse;
    assert.equal(session.events.filter(entry => entry.type === 'tool/call').length, 5);
    assert.ok(!JSON.stringify(session).includes('isError":true'));
    assert.equal(session.events.at(-1)?.data.reason?.kind, 'completed');
    const file = await value<{ content: string; version: string }>(await read(runtime, 'alpha', 'shared', 'notes/test.txt'));
    assert.equal(file.content, 'updated\nneedle');
    assert.equal(file.version, '2');
    assert.match(calls[2]!, /hello/);
    assert.match(calls[4]!, /updated/);
    const events = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'native', 'events')));
    assert.equal(events.status, 200, await events.clone().text());
    assert.deepEqual((await events.json() as SessionResponse).events, session.events);
    const other = await message(runtime, 'other-session', 'shared');
    assert.match(calls.at(-1)!, /updated/);
    assert.equal(other.status, 200, await other.clone().text());
  } finally { await runtime.dispose(); }
});

test('workspace binding is persisted, inherited on followup and cannot be switched', async () => {
  const runtime = createRuntime();
  try {
    assert.equal((await message(runtime, 'bound', 'one')).status, 200);
    assert.equal((await message(runtime, 'bound')).status, 200);
    const switched = await message(runtime, 'bound', 'two');
    assert.equal(switched.status, 409);
    assert.equal((await switched.json() as { code: string }).code, 'WORKSPACE_MISMATCH');
    assert.equal((await message(runtime, 'plain')).status, 200);
    assert.equal((await message(runtime, 'plain', 'one')).status, 409);
  } finally { await runtime.dispose(); }
});

test('Computer files, revisions and session bindings survive a fresh workerd process', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'weft-workspace-'));
  let runtime = createRuntime(persist);
  try {
    await value(await write(runtime, 'alpha', 'restart', 'saved.txt', 'persistent text'));
    assert.equal((await message(runtime, 'restart-session', 'restart')).status, 200);
    await runtime.dispose(); runtime = createRuntime(persist);
    const file = await value<{ content: string; version: string }>(await read(runtime, 'alpha', 'restart', 'saved.txt'));
    assert.deepEqual({ content: file.content, version: file.version }, { content: 'persistent text', version: '1' });
    assert.equal((await message(runtime, 'restart-session')).status, 200);
    assert.equal((await message(runtime, 'restart-session', 'another')).status, 409);
    assert.equal((await value<{ revision: number }>(await write(runtime, 'alpha', 'restart', 'saved.txt', 'new', file.version))).revision, 2);
  } finally { await runtime.dispose(); await rm(persist, { recursive: true, force: true }); }
});

test('native observation policy reports an external concurrent edit and requires a fresh read', async () => {
  let count = 0;
  const runtime = createRuntime(undefined, { bindings: realAdapter, outbound: async request => {
    const body = await request.text();
    count++;
    if (count === 1) return modelReply('read', { file_path: 'note.txt' });
    if (count === 2) {
      assert.match(body, /original/);
      await value(await write(runtime, 'alpha', 'conflicts', 'note.txt', 'external', '1'));
      return modelReply('edit', { file_path: 'note.txt', old_string: 'original', new_string: 'must not overwrite' });
    }
    if (count === 3) {
      assert.equal((await value<{ content: string }>(await read(runtime, 'alpha', 'conflicts', 'note.txt'))).content, 'external');
      return modelReply('read', { file_path: 'note.txt' });
    }
    if (count === 4) return modelReply('edit', { file_path: 'note.txt', old_string: 'external', new_string: 'merged' });
    return modelReply();
  } });
  try {
    await value(await write(runtime, 'alpha', 'conflicts', 'note.txt', 'original'));
    const response = await message(runtime, 'conflicted', 'conflicts');
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /FS_STALE_VERSION/);
    const result = await value<{ content: string; version: string }>(await read(runtime, 'alpha', 'conflicts', 'note.txt'));
    assert.equal(result.content, 'merged');
    assert.equal(result.version, '3');
  } finally { await runtime.dispose(); }
});
