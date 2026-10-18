import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import {createWebConnectionRpc} from '@weft/upstream/packages/client/connection/src/client/rpc.ts';
import type {FileUploadValue} from '@deepseek-ai/dsh-client-file-upload/types';
import type {WorkspaceFileBytes} from '@deepseek-ai/dsh-api-workspace-files/types';
import {ATTACHMENT_ROOT} from '../packages/native-attachments/src/protocol.ts';
import type {FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import type {V4FetchHandler} from 'miniflare';
import {Response as ModelResponse} from 'miniflare';
import type {SessionProjectionsValue} from '@deepseek-ai/dsh-api-session-controller/types';

const base = (environment = 'default', user: 'alpha' | 'beta' = 'alpha') => `/v1/tenants/${tenantId(user)}/environments/${environment}`;
function attachmentPath(ref: FileAttachmentRef): string {
  const digest = ref.attachmentId.slice('sha256:'.length);
  return `${ATTACHMENT_ROOT}/files/${digest.slice(0, 2)}/${digest}/${ref.name}`;
}
async function upload(runtime: ReturnType<typeof createRuntime>, sessionId: string, data: Uint8Array, name = 'notes.txt', environment = 'default', user: 'alpha' | 'beta' = 'alpha') {
  const response = await runtime.dispatchFetch(url(user, base(environment, user)+'/native/api/session/uploadFileBinary?'+new URLSearchParams({sessionId, name})), {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: data as never});
  assert.equal(response.status, 200);
  const result = await response.json() as {ok: boolean; value: FileUploadValue; error?: unknown};
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test('native raw uploads preserve arbitrary bytes in immutable Computer files, sanitize names and use the original byte protocol', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const rpc = createWebConnectionRpc(async (route, init) => {
    const response = await runtime.dispatchFetch(url('alpha', base()+'/native/'+route), init as never);
    return new Response(await response.arrayBuffer(), {status: response.status, headers: Object.fromEntries(response.headers)});
  });
  try {
    await api.call('session/create', {request: {sessionId: 'uploads'}});
    const data = Uint8Array.from({length: 1_048_607}, (_, i) => i % 251);
    const receipt = await upload(runtime, 'uploads', data, '../local\\CON.txt');
    assert.equal(receipt.file.name, '_CON.txt');
    assert.equal(receipt.file.bytes, data.byteLength);
    assert.equal(receipt.file.attachmentId, 'sha256:'+createHash('sha256').update(data).digest('hex'));
    const path = attachmentPath(receipt.file);
    const bytes = await rpc.call('/api', 'workspaceFiles/readBytes', {args: {workspaceFileScopeId: 'uploads', path, options: {}}});
    assert.ok(bytes.ok, JSON.stringify(bytes));
    assert.deepEqual((bytes.value as WorkspaceFileBytes).data, data);
    const replaced = await runtime.dispatchFetch(url('alpha', base()+'/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path, content: 'mutated', expectedVersion: '1'})});
    assert.equal(replaced.status, 403);
    const duplicate = await upload(runtime, 'uploads', data, receipt.file.name);
    assert.deepEqual(duplicate.file, receipt.file);
    assert.notEqual(duplicate.receiptId, receipt.receiptId);
    const empty = await upload(runtime, 'uploads', new Uint8Array(), 'empty.bin');
    assert.equal(empty.file.bytes, 0);
    const projections = await api.call<{values: {imageLimits: {mediaTypes: string[]}}}>('session/projections', {request: {sessionId: 'uploads'}});
    assert.deepEqual(projections.values.imageLimits.mediaTypes, []);
    assert.equal((await api.raw('fileUploads/upload', {agentId: 'uploads', request: {data: '*bad*'}})).result.error?.code, 'session/attachment-invalid');
  } finally {await runtime.dispose();}
});

test('upload receipts survive a cold workerd host, enter real prompts and expose actual filesystem paths to the native model adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-attachments-'));
  const calls: string[] = [];
  let path = '';
  const outbound: V4FetchHandler = async request => {
    const body = await request.text(); calls.push(body);
    if (calls.length === 1) {
      assert.ok(body.includes(path), 'the real LLM projection includes the Computer path');
      return nativeFixtureResponse({name: 'read', input: {file_path: path}});
    }
    assert.ok(body.includes('native uploaded invoice'), 'the native read tool returned the actual upload bytes');
    return nativeFixtureResponse();
  };
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'attachment-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'persisted-upload'}});
    const receipt = await api.call<FileUploadValue>('fileUploads/upload', {agentId: 'persisted-upload', request: {name: 'invoice.txt', data: Buffer.from('native uploaded invoice').toString('base64')}});
    path = attachmentPath(receipt.file);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const requestId = crypto.randomUUID();
    const request = {sessionId: 'persisted-upload', requestId, mode: 'queue', content: [{type: 'file', receiptId: receipt.receiptId}]};
    await api.call('session/prompt', {request});
    const events = await (await runtime.dispatchFetch(url('alpha', base()+'/sessions/persisted-upload/events'))).json();
    assert.ok(JSON.stringify(events).includes('native uploaded invoice'));
    assert.ok(JSON.stringify(events).includes(receipt.file.attachmentId));
    assert.ok(!JSON.stringify(events).includes('isError":true'));
    const before = calls.length;
    await api.call('session/prompt', {request});
    assert.equal(calls.length, before, 'native request dedup works after receipt retirement');
    const reused = await api.raw('session/prompt', {request: {...request, requestId: crypto.randomUUID()}});
    assert.equal(reused.result.error?.code, 'session/attachment-invalid');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('raw upload and prompt admission enforce Access, environment and exact Session receipt ownership', async () => {
  const runtime = createRuntime();
  const api = nativeClient(() => runtime);
  const other = nativeClient(() => runtime, 'other');
  const beta = nativeClient(() => runtime, 'default', 'beta');
  try {
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})});
    for (const client of [api, other, beta]) await client.call('session/create', {request: {sessionId: 'same'}});
    await api.call('session/create', {request: {sessionId: 'another'}});
    const receipt = await upload(runtime, 'same', new TextEncoder().encode('owner file'));
    for (const [client, sessionId] of [[api, 'another'], [other, 'same'], [beta, 'same']] as const) {
      const denied = await client.raw('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'file', receiptId: receipt.receiptId}]}});
      assert.equal(denied.result.error?.code, 'session/attachment-invalid');
    }
    const endpoint = base()+'/native/api/session/uploadFileBinary?sessionId=same';
    const cross = await runtime.dispatchFetch(url('alpha', endpoint), {method: 'POST', headers: {'content-type': 'application/octet-stream', origin: 'https://other.example'}, body: 'bad'});
    assert.equal(cross.status, 403);
    assert.equal((await runtime.dispatchFetch(url('beta', endpoint), {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: 'bad'})).status, 403);
    assert.equal((await runtime.dispatchFetch(url('alpha', endpoint), {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status, 415);
    const missing = await runtime.dispatchFetch(url('alpha', base()+'/native/api/session/uploadFileBinary?sessionId=missing'), {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: 'bytes'});
    assert.equal((await missing.json() as {error: {code: string}}).error.code, 'session/not-found');
    const directRef = await api.raw('session/prompt', {request: {sessionId: 'same', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'file', attachment: receipt.file}]}});
    assert.equal(directRef.result.error?.code, 'gateway/bad-request');
  } finally {await runtime.dispose();}
});

test('queued file input and receipt retirement survive native cancellation and cold host reconstruction', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-queued-attachments-'));
  const started = Promise.withResolvers<void>();
  const requests: string[] = [];
  let hold = true;
  const outbound: V4FetchHandler = async request => {
    requests.push(await request.text());
    if (hold) {
      hold = false; started.resolve();
      return new ModelResponse(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      }}), {headers: {'content-type': 'text/event-stream'}});
    }
    return nativeFixtureResponse();
  };
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'queued-attachment-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const prompt = (requestId: string, content: unknown[]) => api.call('session/prompt', {request: {sessionId: 'queued', requestId, mode: 'queue', content}});
  const inbox = async () => {
    const projection = await api.call<SessionProjectionsValue>('session/projections', {request: {sessionId: 'queued'}});
    if (projection?.kind !== 'sequenced' || !projection.values.inbox) throw new Error('Missing inbox');
    return projection.values.inbox;
  };
  try {
    await api.call('session/create', {request: {sessionId: 'queued'}});
    await prompt(crypto.randomUUID(), [{type: 'text', text: 'Hold this turn'}]);
    await started.promise;
    const kept = await upload(runtime, 'queued', new TextEncoder().encode('kept file bytes'), 'kept.txt');
    const removed = await upload(runtime, 'queued', new TextEncoder().encode('removed file bytes'), 'removed.txt');
    const keptId = crypto.randomUUID(), removedId = crypto.randomUUID();
    await prompt(keptId, [{type: 'file', receiptId: kept.receiptId}]);
    await prompt(removedId, [{type: 'file', receiptId: removed.receiptId}]);
    const pending = await inbox();
    assert.equal(pending['next-turn'].length, 2);
    const queued = pending['next-turn'] as {id: string; source: {kind: string; rpcId?: string}}[];
    const item = queued.find(message => message.source.kind === 'user' && message.source.rpcId === removedId)!;
    await api.call('session/updateQueue', {request: {sessionId: 'queued', itemId: item.id, action: {kind: 'remove'}}});
    assert.equal((await api.raw('session/prompt', {request: {sessionId: 'queued', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'file', receiptId: removed.receiptId}]}})).result.error?.code, 'session/attachment-invalid');
    await api.call('session/cancel', {request: {sessionId: 'queued'}});
    assert.equal((await inbox())['next-turn'].length, 1);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    await prompt(crypto.randomUUID(), [{type: 'text', text: 'Resume the queue'}]);
    const events = await (await runtime.dispatchFetch(url('alpha', base()+'/sessions/queued/events'))).json() as {events: {type: string; data: unknown}[]};
    const consumed = events.events.filter(event => event.type === 'user/message');
    assert.ok(JSON.stringify(consumed).includes(kept.file.attachmentId));
    assert.ok(!JSON.stringify(consumed).includes(removed.file.attachmentId));
    assert.ok(requests.slice(1).some(body => body.includes(attachmentPath(kept.file))));
    assert.equal((await api.raw('session/prompt', {request: {sessionId: 'queued', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'file', receiptId: kept.receiptId}]}})).result.error?.code, 'session/attachment-invalid');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
