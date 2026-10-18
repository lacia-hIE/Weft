import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {Response as ModelResponse, type V4FetchHandler} from 'miniflare';
import type {FileUploadValue} from '@deepseek-ai/dsh-client-file-upload/types';
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';
import {imageFixtures} from './helpers/images.ts';
import {ATTACHMENT_ROOT} from '../packages/native-attachments/src/protocol.ts';

const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
const bindings = {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'image-tool-fixture', DEEPSEEK_BASE_URL: 'https://image-tool.test/anthropic'};

test('the original read_image tool reads actual Computer bytes, publishes authorized history and sends pixels through native DeepSeek Files', async () => {
  const fixture = await imageFixtures();
  let path = '', requests = 0;
  const uploaded: Buffer[] = [];
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).pathname.endsWith('/files')) {
      const form = await request.formData(), file = form.get('file');
      assert.ok(file && typeof file !== 'string');
      const data = Buffer.from(await file.arrayBuffer()); uploaded.push(data);
      assert.equal(file.type, 'image/webp');
      assert.deepEqual([(await sharp(data).metadata()).width, (await sharp(data).metadata()).height], [64, 32]);
      return ModelResponse.json({id: 'native-read-image-file', type: 'file', mime_type: file.type, size_bytes: data.byteLength, created_at: new Date().toISOString(), filename: file.name});
    }
    const body = await request.json() as {tools: Array<{name: string}>; messages: unknown[]};
    assert.ok(body.tools.some(tool => tool.name === 'read_image'));
    if (++requests === 1) return nativeFixtureResponse({name: 'read_image', input: {file_path: path}});
    assert.ok(JSON.stringify(body.messages).includes('native-read-image-file'));
    return nativeFixtureResponse();
  };
  const runtime = createRuntime(undefined, {browser: true, images: true, bindings, outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'read-image'}});
    const receipt = await api.call<FileUploadValue>('fileUploads/upload', {agentId: 'read-image', request: {data: fixture.png.toString('base64'), name: 'source.png'}});
    const digest = receipt.file.attachmentId.slice('sha256:'.length);
    path = `${ATTACHMENT_ROOT}/files/${digest.slice(0, 2)}/${digest}/${receipt.file.name}`;
    await api.call('session/prompt', {request: {sessionId: 'read-image', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Inspect the uploaded image with read_image.'}, {type: 'file', receiptId: receipt.receiptId}]}});
    const {events} = await (await runtime.dispatchFetch(url('alpha', base + '/sessions/read-image/events'))).json() as {events: Array<{type: string; data: unknown}>};
    assert.equal(requests, 2); assert.equal(uploaded.length, 1);
    const settled = JSON.stringify(events.filter(event => event.type === 'tool/result').map(event => event.data));
    assert.ok(settled.includes('"type":"image"'));
    const attachmentId = /"attachmentId":"(sha256:[a-f0-9]{64})"/.exec(settled)?.[1];
    assert.ok(attachmentId);
    const value = await api.call<{attachment: ImageAttachmentRef; data: string}>('session/attachment', {request: {sessionId: 'read-image', attachmentId}});
    const data = Buffer.from(value.data, 'base64');
    assert.equal('sha256:' + createHash('sha256').update(data).digest('hex'), attachmentId);
    assert.equal(value.attachment.name, 'source.png');
    await api.call('session/create', {request: {sessionId: 'unrelated'}});
    assert.equal((await api.raw('session/attachment', {request: {sessionId: 'unrelated', attachmentId}})).result.error?.code, 'session/attachment-invalid');
  } finally {await runtime.dispose();}
});

test('read_image respects codec and model capability gates and refuses escaping paths or invalid files without publishing image references', async () => {
  for (const mode of ['no-codec', 'text-only', 'escape', 'invalid'] as const) {
    let requests = 0;
    const outbound: V4FetchHandler = async request => {
      assert.ok(new URL(request.url).pathname.endsWith('/messages'), 'refusals must not upload to the model Files API');
      const body = await request.json() as {tools: Array<{name: string}>; messages: unknown[]};
      const present = body.tools.some(tool => tool.name === 'read_image');
      assert.equal(present, mode !== 'no-codec');
      if (++requests === 1 && present) return nativeFixtureResponse({name: 'read_image', input: {file_path: mode === 'escape' ? '/workspace/../../private.png' : '/workspace/invalid.png'}});
      if (present) assert.ok(JSON.stringify(body.messages).includes('"is_error":true'));
      if (mode === 'text-only') assert.ok(JSON.stringify(body.messages).includes('does not declare image input'), 'the exact model gate must run before checking the nonexistent file');
      return nativeFixtureResponse();
    };
    const runtime = createRuntime(undefined, {browser: true, images: mode !== 'no-codec', bindings: {...bindings, ...(mode === 'text-only' ? {DEEPSEEK_MODEL: 'text-only-fixture'} : {})}, outbound});
    const api = nativeClient(() => runtime);
    try {
      await api.call('session/create', {request: {sessionId: mode}});
      if (mode === 'invalid') {
        const response = await runtime.dispatchFetch(url('alpha', base + '/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: '/workspace/invalid.png', content: 'This is not an image.', expectedVersion: null})});
        assert.equal(response.status, 200); await response.json();
      }
      await api.call('session/prompt', {request: {sessionId: mode, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Inspect the file.'}]}});
      const events = await (await runtime.dispatchFetch(url('alpha', base + '/sessions/' + mode + '/events'))).json();
      assert.equal(requests, mode === 'no-codec' ? 1 : 2);
      assert.ok(!JSON.stringify(events).includes('"type":"image"'));
      const files = await api.call<{entries: Array<{name: string}>}>('workspaceFiles/list', {workspaceFileScopeId: mode, path: '/workspace'});
      assert.ok(!files.entries.some(entry => entry.name === '.weft'));
    } finally {await runtime.dispose();}
  }
});
