import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Response } from 'miniflare';
import type { WorkspaceValue, WorkspaceCreateValue, WorkspaceFollowFrame, WorkspaceBaseline } from '@deepseek-ai/dsh-api-workspace-controller/types';
import type { SessionControlFrame, SessionCreateValue, ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('native Workspace commands, real directories, membership, pins, archival and order survive restart without deleting files', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-workspaces-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  let stream: Awaited<ReturnType<typeof api.stream<WorkspaceFollowFrame>>> | undefined;
  try {
    stream = await api.stream<WorkspaceFollowFrame>('workspace/follow', {});
    assert.deepEqual(await stream.next(), {type: 'baseline', value: {items: [], archivedSessionIds: [], pinnedSessionIds: []}});
    const root = await api.call<WorkspaceValue>('workspace/initializeDefault', {});
    assert.equal(root.workspace.path, '/workspace');
    assert.equal((await stream.next()).type, 'upsert');
    assert.equal((await stream.next()).type, 'order');
    const path = await api.call<string>('directoryPicker/createDirectory', {path: '/workspace', name: 'project'});
    assert.equal(path, '/workspace/project');
    const listing = await api.call<{entries: {path: string}[]}>('directoryPicker/list', {});
    assert.deepEqual(listing.entries.map(entry => entry.path), [path]);
    const project = await api.call<WorkspaceCreateValue>('workspace/create', {request: {path}});
    assert.equal(project.created, true);
    assert.equal((await api.call<WorkspaceCreateValue>('workspace/create', {request: {path: path+'/'}})).created, false);
    assert.equal((await api.raw('workspace/create', {request: {path: '/workspace/missing'}})).result.error?.code, 'workspace/invalid-path');
    assert.equal((await api.raw('directoryPicker/createDirectory', {path: '/workspace', name: '../escape'})).result.error?.code, 'directory-picker/create-failed');
    assert.equal((await api.raw('workspace/rename', {request: {workspaceId: project.workspace.workspaceId, title: root.workspace.title}})).result.error?.code, 'workspace/name-conflict');
    const renamed = await api.call<WorkspaceValue>('workspace/rename', {request: {workspaceId: project.workspace.workspaceId, title: 'Project renamed'}});
    assert.equal(renamed.workspace.title, 'Project renamed');
    const session = await api.call<SessionCreateValue>('session/create', {request: {sessionId: 'project-session', workspaceId: project.workspace.workspaceId}});
    const history = await api.follow(session.sessionId);
    try {
      const opening = await history.next();
      assert.equal(opening.type, 'snapshot');
      if (opening.type !== 'snapshot') throw new Error('Missing native history');
      assert.equal(opening.header.cwd, path);
    } finally { await history.close(); }
    const filePath = `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`;
    const written = await runtime.dispatchFetch(url('alpha', filePath), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: path+'/kept.txt', content: 'real Computer bytes', expectedVersion: null})});
    assert.equal(written.status, 200);
    const order = await api.call<{workspaceIds: string[]}>('workspace/insertBefore', {request: {workspaceId: root.workspace.workspaceId, beforeWorkspaceId: project.workspace.workspaceId}});
    assert.deepEqual(order.workspaceIds, [root.workspace.workspaceId, project.workspace.workspaceId]);
    assert.deepEqual(await api.call('workspace/pinSession', {request: {sessionId: session.sessionId}}), {pinnedSessionIds: [session.sessionId]});
    assert.deepEqual(await api.call('workspace/archiveSession', {request: {sessionId: session.sessionId}}), {archivedSessionIds: [session.sessionId]});
    assert.equal((await api.raw('workspace/pinSession', {request: {sessionId: session.sessionId}})).result.error?.code, 'gateway/bad-request');
    await api.call('workspace/unarchiveSession', {request: {sessionId: session.sessionId}});
    await api.call('workspace/pinSession', {request: {sessionId: session.sessionId}});
    await stream.close(); stream = undefined;
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    stream = await api.stream<WorkspaceFollowFrame>('workspace/follow', {});
    const restored = await stream.next();
    assert.equal(restored.type, 'baseline');
    if (restored.type !== 'baseline') throw new Error('Missing restored baseline');
    assert.equal(restored.value.items[1]!.title, 'Project renamed');
    assert.deepEqual(restored.value.items[1]!.sessionIds, [session.sessionId]);
    assert.deepEqual(restored.value.pinnedSessionIds, [session.sessionId]);
    await api.call('workspace/delete', {request: {workspaceId: project.workspace.workspaceId}});
    const read = await runtime.dispatchFetch(url('alpha', filePath+'?path='+encodeURIComponent(path+'/kept.txt')));
    assert.equal(read.status, 200);
    assert.match(await read.text(), /real Computer bytes/);
    const adopted = await api.call<WorkspaceCreateValue>('workspace/create', {request: {path}});
    assert.notEqual(adopted.workspace.workspaceId, project.workspace.workspaceId);
    assert.deepEqual(adopted.workspace.sessionIds, [], 'the original Registry creates a new empty registration');
    assert.match(JSON.stringify(await api.call('session/list', {_request: {}})), /project-session/, 'removing the registration retains the session log');
    const control = await api.stream<SessionControlFrame>('session/control', {});
    try {
      assert.equal((await control.next()).type, 'baseline');
      await api.call('session/rename', {request: {sessionId: session.sessionId, title: 'control stream title'}});
      let titleSeen = false;
      for (let index = 0; index < 8 && !titleSeen; index++) {
        const frame = await control.next();
        assert.equal(frame.type, 'projection');
        if (frame.type === 'projection' && frame.key === 'title') {
          assert.equal(frame.sessionId, session.sessionId);
          assert.equal(frame.value, 'control stream title');
          titleSeen = true;
        }
      }
      assert.equal(titleSeen, true, 'other native projection updates may precede the title');
    } finally { await control.close(); }
    const catalog = await api.call<ModelCatalog>('session/modelCatalog', {});
    assert.deepEqual(catalog.default, {provider: 'validation', model: 'scripted'});
    assert.equal(catalog.groups[0]!.models[0]!.id, 'scripted');
  } finally { await stream?.close(); await runtime.dispose(); await rm(directory, {recursive: true, force: true}); }
});

test('a native Session uses its selected project cwd for the real upstream relative file tool', {timeout: 60_000}, async () => {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  let calls = 0;
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'native-workspace-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: async () => {
    const tool = calls++ === 0;
    const name = tool ? 'tool_use' : 'text';
    const block = tool ? {type: name, id: 'write-relative', name: 'write', input: {}} : {type: name, text: ''};
    const delta = tool ? {type: 'input_json_delta', partial_json: JSON.stringify({file_path: 'relative.txt', content: 'selected project bytes'})} : {type: 'text_delta', text: 'done'};
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: block}) + event('content_block_delta', {index: 0, delta}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
  }});
  const api = nativeClient(() => runtime);
  try {
    await api.call('directoryPicker/createDirectory', {path: '/workspace', name: 'project'});
    const project = await api.call<WorkspaceCreateValue>('workspace/create', {request: {path: '/workspace/project'}});
    await api.call('session/create', {request: {sessionId: 'relative', workspaceId: project.workspace.workspaceId}});
    await api.call('session/prompt', {request: {sessionId: 'relative', requestId: randomUUID(), mode: 'queue', content: [{type: 'text', text: 'write a relative file'}]}});
    const history = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/relative/events`));
    assert.equal(history.status, 200);
    const read = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files?path=/workspace/project/relative.txt`));
    assert.equal(read.status, 200, await read.clone().text());
    assert.match(await read.text(), /selected project bytes/);
    const outside = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files?path=/workspace/relative.txt`));
    assert.equal(outside.status, 404);
  } finally { await runtime.dispose(); }
});
