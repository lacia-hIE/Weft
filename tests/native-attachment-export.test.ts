import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import {createWebConnectionRpc} from '@weft/upstream/packages/client/connection/src/client/rpc.ts';
import type {FileUploadValue} from '@deepseek-ai/dsh-client-file-upload/types';
import type {WorkspaceFileBytes} from '@deepseek-ai/dsh-api-workspace-files/types';
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import type {SessionEventMap} from '@deepseek-ai/dsh-session';
import {Response, type V4FetchHandler} from 'miniflare';
import {imageFixtures} from './helpers/images.ts';

const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
const bindings = {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'export-fixture', DEEPSEEK_BASE_URL: 'https://attachment-export.test/anthropic'};
function filePath(file: FileUploadValue['file']) {
  const hash = file.attachmentId.slice(7);
  return `/workspace/.weft/attachments/v1/files/${hash.slice(0, 2)}/${hash}/${file.name}`;
}
function bytesClient(runtime: ReturnType<typeof createRuntime>) {
  return createWebConnectionRpc(async (route, init) => {
    const response = await runtime.dispatchFetch(url('alpha', base + '/native/' + route), init as never);
    return new globalThis.Response(await response.arrayBuffer(), {status: response.status, headers: Object.fromEntries(response.headers)});
  });
}

async function promptTurn(api: ReturnType<typeof nativeClient>, sessionId: string, content: unknown[]) {
  const follow = await api.follow(sessionId);
  await follow.next();
  try {
    await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
  } finally {await follow.close();}
}

test('native attachment export copies exact binary bytes to a script-readable file while the private path remains blocked', async () => {
  const bytes = Uint8Array.from({length: 1_048_607}, (_, i) => i % 251), digest = createHash('sha256').update(bytes).digest('hex');
  let source = '', requests = 0;
  const outbound: V4FetchHandler = async request => {
    const body = await request.text();
    switch (++requests) {
      case 1: return nativeFixtureResponse({name: 'bash', input: {command: `cat '${source}'`, description: 'Probe the private attachment boundary'}});
      case 2:
        assert.match(body, /attachment storage is not accessible|No such file or directory/);
        return nativeFixtureResponse({name: 'export_attachment', input: {destination: 'inputs/blob.bin'}});
      case 3:
        assert.ok(body.includes('/workspace/inputs/blob.bin'));
        return nativeFixtureResponse({name: 'bash', input: {command: 'sha256sum /workspace/inputs/blob.bin', description: 'Verify the exported attachment bytes'}});
      case 4:
        assert.ok(body.includes(digest + '  /workspace/inputs/blob.bin'), 'the real shell hashes the exported bytes');
        return nativeFixtureResponse();
      default: throw new Error('Unexpected model request');
    }
  };
  const runtime = createRuntime(undefined, {browser: true, bindings, outbound}), api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'export-original'}});
    const receipt = await api.call<FileUploadValue>('fileUploads/upload', {agentId: 'export-original', request: {name: 'original.bin', data: Buffer.from(bytes).toString('base64')}});
    source = filePath(receipt.file);
    await promptTurn(api, 'export-original', [{type: 'file', receiptId: receipt.receiptId}]);
    assert.equal(requests, 4);
    const result = await bytesClient(runtime).call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'export-original', path: '/workspace/inputs/blob.bin', options: {}}});
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual((result.value as WorkspaceFileBytes).data, bytes);
    const mutation = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: source, content: 'replace private bytes', expectedVersion: null})});
    assert.equal(mutation.status, 403, 'the attachment remains immutable');
  } finally {await runtime.dispose();}
});

test('export refuses foreign references, read-only writes, workspace escapes, private targets and overwrite', {timeout: 120000}, async () => {
  let input: {source?: string; destination: string}, expected = '', requests = 0;
  const outbound: V4FetchHandler = async request => {
    const body = await request.text();
    if (++requests % 2) return nativeFixtureResponse({name: 'export_attachment', input});
    assert.ok(body.includes(expected), `Expected export refusal ${expected}: ${body.slice(-4000)}`);
    return nativeFixtureResponse();
  };
  const runtime = createRuntime(undefined, {browser: true, bindings, outbound}), api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'owner'}});
    const foreign = await api.call<FileUploadValue>('fileUploads/upload', {agentId: 'owner', request: {name: 'foreign.txt', data: Buffer.from('foreign bytes').toString('base64')}});
    const create = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: '/workspace/exists.txt', content: 'keep this', expectedVersion: null})});
    assert.equal(create.status, 200);
    const cases = [
      {id: 'foreign', source: filePath(foreign.file), destination: '/workspace/foreign.txt', error: 'not an attachment referenced'},
      {id: 'readonly', destination: '/workspace/readonly.txt', error: 'outside the writable Session workspace'},
      {id: 'escape', destination: '/workspace/outside.txt', cwd: '/workspace/project', error: 'outside the writable Session workspace'},
      {id: 'private', destination: '/workspace/.weft/exported.txt', error: 'Attachment storage is immutable'},
      {id: 'overwrite', destination: '/workspace/exists.txt', error: 'destination already exists'},
    ];
    for (const scenario of cases) {
      if (scenario.cwd) await api.call('directoryPicker/createDirectory', {path: '/workspace', name: 'project'});
      await api.call('session/create', {request: {sessionId: scenario.id, ...(scenario.cwd ? {cwd: scenario.cwd} : {})}});
      if (scenario.id === 'readonly') await api.call('commands/execute', {agentId: scenario.id, line: '/permission read-only', submittedAttachments: []});
      const receipt = await api.call<FileUploadValue>('fileUploads/upload', {agentId: scenario.id, request: {name: 'own.txt', data: Buffer.from('own bytes').toString('base64')}});
      input = {destination: scenario.destination, ...('source' in scenario ? {source: scenario.source} : {})}; expected = scenario.error;
      await promptTurn(api, scenario.id, [{type: 'file', receiptId: receipt.receiptId}]);
    }
    assert.equal(requests, cases.length * 2);
    const existing = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files?path=/workspace/exists.txt'));
    assert.equal((await existing.json() as {value: {content: string}}).value.content, 'keep this');
    for (const path of ['foreign.txt', 'readonly.txt', 'outside.txt']) assert.equal((await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files?path=' + path))).status, 404);
  } finally {await runtime.dispose();}
});

test('image-only export exposes the stored normalized WebP bytes without claiming to recover the original upload', async () => {
  const fixture = await imageFixtures(); let requests = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).pathname.endsWith('/files')) {
      const form = await request.formData(), file = form.get('file'); assert.ok(file && typeof file !== 'string');
      return Response.json({id: 'export-image', type: 'file', mime_type: file.type, size_bytes: file.size, created_at: new Date().toISOString(), filename: file.name});
    }
    await request.text();
    return ++requests === 1 ? nativeFixtureResponse({name: 'export_attachment', input: {destination: 'inputs/picture.webp'}}) : nativeFixtureResponse();
  };
  const runtime = createRuntime(undefined, {browser: true, images: true, bindings, outbound}), api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'image-export'}});
    await promptTurn(api, 'image-export', [{type: 'image', mediaType: 'image/png', data: fixture.png.toString('base64')}]);
    assert.equal(requests, 2);
    const history = await (await runtime.dispatchFetch(url('alpha', base + '/sessions/image-export/events'))).json() as {events: {type: string; data: unknown}[]};
    const message = history.events.find(event => event.type === 'user/message')!.data as SessionEventMap['user/message'];
    const image = message.content.find(part => part.type === 'image') as {attachment: ImageAttachmentRef};
    const stored = await api.call<{data: string}>('session/attachment', {request: {sessionId: 'image-export', attachmentId: image.attachment.attachmentId}});
    const result = await bytesClient(runtime).call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'image-export', path: '/workspace/inputs/picture.webp', options: {}}});
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(Buffer.from((result.value as WorkspaceFileBytes).data), Buffer.from(stored.data, 'base64'));
  } finally {await runtime.dispose();}
});
