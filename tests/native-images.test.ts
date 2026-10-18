import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {imageFixtures, paddedPng} from './helpers/images.ts';
import {Response as ModelResponse, type V4FetchHandler} from 'miniflare';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';

test('native image admission normalizes actual PNG bytes and authorizes original image reads across cold hosts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-images-'));
  const fixture = await imageFixtures();
  let runtime = createRuntime(directory, {browser: true, images: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'images'}});
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true, images: true});
    const limits = await api.call<{values: {imageLimits: {mediaTypes: string[]}}}>('session/projections', {request: {sessionId: 'images'}});
    assert.deepEqual(limits.values.imageLimits.mediaTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const input = {sessionId: 'images', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'inspect image'}, {type: 'image', mediaType: 'image/png', data: fixture.png.toString('base64'), name: '../private\\red.png'}]};
    await api.call('session/prompt', {request: input});
    const eventsResponse = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/images/events`));
    const {events} = await eventsResponse.json() as {events: Array<{type: string; data: unknown}>};
    const serialized = JSON.stringify(events);
    assert.ok(serialized.includes('sha256:'));
    assert.ok(!serialized.includes(fixture.png.toString('base64')));
    const messages = events.filter(event => event.type === 'user/message').map(event => event.data) as Array<{content: Array<{type: string; attachment?: ImageAttachmentRef}>}>;
    const ref = messages.flatMap(message => message.content).find(block => block.type === 'image')?.attachment;
    assert.ok(ref);
    assert.equal(ref.name, 'red.png'); assert.equal(ref.mediaType, 'image/webp');
    assert.deepEqual([ref.width, ref.height], [64, 32]);
    const stored = await api.call<{attachment: ImageAttachmentRef; data: string}>('session/attachment', {request: {sessionId: 'images', attachmentId: ref.attachmentId}});
    const bytes = Buffer.from(stored.data, 'base64');
    assert.equal(ref.attachmentId, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
    const decoded = await sharp(bytes).metadata();
    assert.equal(decoded.depth, 'uchar'); assert.equal(decoded.space, 'srgb'); assert.equal(decoded.hasAlpha, true); assert.equal(decoded.exif, undefined); assert.equal(decoded.icc, undefined);
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true, images: true});
    assert.deepEqual(await api.call('session/attachment', {request: {sessionId: 'images', attachmentId: ref.attachmentId}}), stored);
    await api.call('session/create', {request: {sessionId: 'other'}});
    assert.equal((await api.raw('session/attachment', {request: {sessionId: 'other', attachmentId: ref.attachmentId}})).result.error?.code, 'session/attachment-invalid');
    assert.equal((await api.raw('session/attachment', {request: {sessionId: 'missing', attachmentId: ref.attachmentId}})).result.error?.code, 'session/not-found');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('invalid native image batches never enter the Inbox or publish a valid prefix', async () => {
  const fixture = await imageFixtures();
  const runtime = createRuntime(undefined, {browser: true, images: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'invalid-images'}});
    const valid = {type: 'image', mediaType: 'image/png', data: fixture.png.toString('base64')};
    for (const invalid of [{...valid, data: '*not-base64*'}, {...valid, mediaType: 'image/jpeg'}, {...valid, data: fixture.png.subarray(0, 33).toString('base64')}, {...valid, data: fixture.png.subarray(0, Math.floor(fixture.png.length / 2)).toString('base64')}]) {
      const result = await api.raw('session/prompt', {request: {sessionId: 'invalid-images', requestId: crypto.randomUUID(), mode: 'queue', content: [valid, invalid]}});
      assert.equal(result.result.error?.code, 'session/attachment-invalid');
    }
    const files = await api.call<{entries: Array<{name: string}>}>('workspaceFiles/list', {workspaceFileScopeId: 'invalid-images', path: '/workspace'});
    assert.equal(files.entries.some(file => file.name === '.weft'), false);
    const events = await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/invalid-images/events`))).json();
    assert.ok(!JSON.stringify(events).includes('sha256:'));
  } finally {await runtime.dispose();}
});

test('PNG, JPEG, WebP and animated GIF inputs become single-frame durable images', async () => {
  const fixtures = await imageFixtures();
  const runtime = createRuntime(undefined, {browser: true, images: true});
  const api = nativeClient(() => runtime);
  try {
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const sessionId = 'format-' + format;
      await api.call('session/create', {request: {sessionId}});
      await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'image', mediaType: 'image/' + format, data: fixtures[format].toString('base64')}]}});
      const {events} = await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/${sessionId}/events`))).json() as {events: Array<{type: string; data: {content?: Array<{type: string; attachment?: ImageAttachmentRef}>}}>};
      const ref = events.filter(event => event.type === 'user/message').flatMap(event => event.data.content ?? []).find(block => block.type === 'image')?.attachment;
      assert.ok(ref);
      const stored = await api.call<{data: string}>('session/attachment', {request: {sessionId, attachmentId: ref.attachmentId}});
      const pixels = sharp(Buffer.from(stored.data, 'base64'));
      const info = await pixels.metadata();
      assert.equal(info.format, 'webp'); assert.equal(info.depth, 'uchar'); assert.equal(info.space, 'srgb'); assert.equal(info.pages ?? 1, 1);
      if (format === 'gif') {
        const first = await pixels.raw().toBuffer();
        assert.ok(first[0]! > 200 && first[1]! < 20, 'the first GIF frame remains red');
      }
    }
  } finally {await runtime.dispose();}
});

test('the native DeepSeek Files transport uploads actual request pixels, reuses environment mappings after restart and isolates shared credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-image-files-'));
  const fixture = await imageFixtures();
  const uploads: Array<{id: string; data: Buffer; name: string}> = [];
  const messages: unknown[] = [];
  const deleted: string[] = [];
  let quotaNext = false;
  const outbound: V4FetchHandler = async request => {
    if (request.method === 'DELETE') {const id = new URL(request.url).pathname.split('/').at(-1)!; deleted.push(id); return ModelResponse.json({id, type: 'file_deleted'});}
    if (new URL(request.url).pathname.endsWith('/files') && request.method === 'POST') {
      if (quotaNext) {quotaNext = false; return ModelResponse.json({error: {type: 'quota_exceeded', message: 'Stored file quota exceeded'}}, {status: 429});}
      const form = await request.formData();
      const file = form.get('file');
      assert.ok(file && typeof file !== 'string');
      const item = {id: 'image-file-' + (uploads.length + 1), data: Buffer.from(await file.arrayBuffer()), name: file.name};
      uploads.push(item);
      assert.equal(file.type, 'image/webp');
      assert.match(item.name, /^dsh-/);
      assert.ok((await sharp(item.data).metadata()).width);
      return ModelResponse.json({id: item.id, type: 'file', mime_type: 'image/webp', size_bytes: item.data.byteLength, created_at: new Date().toISOString(), filename: item.name});
    }
    assert.ok(new URL(request.url).pathname.endsWith('/messages'));
    messages.push(await request.json());
    return nativeFixtureResponse();
  };
  const options = {browser: false, images: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'shared-image-fixture', DEEPSEEK_BASE_URL: 'https://images-model.test/anthropic'}, outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const prompt = async (client: typeof api, sessionId: string, image = fixture.png) => {
    await client.call('session/create', {request: {sessionId}});
    await client.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'image', mediaType: 'image/png', data: image.toString('base64')}]}});
  };
  try {
    await prompt(api, 'vision-one');
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/vision-one/events`)).then(response => response.json());
    assert.equal(uploads.length, 1);
    assert.ok(JSON.stringify(messages[0]).includes('"file_id":"image-file-1"'));
    assert.ok(!JSON.stringify(messages[0]).includes('"type":"base64"'));
    await runtime.dispose(); runtime = createRuntime(directory, options);
    await prompt(api, 'vision-two');
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/vision-two/events`)).then(response => response.json());
    assert.equal(uploads.length, 1, 'a cold second Session reuses the environment upload');
    const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'separate', name: 'Separate'})});
    assert.equal(response.status, 201); await response.json();
    const other = nativeClient(() => runtime, 'separate');
    await prompt(other, 'vision-one');
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/separate/sessions/vision-one/events`)).then(response => response.json());
    assert.equal(uploads.length, 2, 'another environment retains its own remote mapping even with the same API key');
    assert.ok(JSON.stringify(messages.at(-1)).includes('"file_id":"image-file-2"'));
    quotaNext = true;
    const blue = await sharp({create: {width: 64, height: 32, channels: 4, background: {r: 0, g: 0, b: 255, alpha: 0.5}}}).png().toBuffer();
    await prompt(api, 'vision-quota', blue);
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/vision-quota/events`)).then(response => response.json());
    assert.deepEqual(deleted, ['image-file-1'], 'quota recovery only deletes IDs indexed by the current environment');
    assert.equal(uploads.length, 3);
    await prompt(other, 'vision-separate-two');
    await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/separate/sessions/vision-separate-two/events`)).then(response => response.json());
    assert.equal(uploads.length, 3, 'cleanup preserves another environment upload');
    assert.ok(JSON.stringify(messages.at(-1)).includes('"file_id":"image-file-2"'));
    const beta = nativeClient(() => runtime, 'default', 'beta');
    await prompt(beta, 'vision-one');
    await runtime.dispatchFetch(url('beta', `/v1/tenants/${tenantId('beta')}/environments/default/sessions/vision-one/events`)).then(response => response.json());
    assert.equal(uploads.length, 4, 'another Access tenant keeps a distinct mapping under the shared platform key');
    assert.ok(JSON.stringify(messages.at(-1)).includes('"file_id":"image-file-4"'));

  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('the complete native prompt accepts the configured 20 MB image and enforces count and aggregate bounds before publication', {timeout: 120_000}, async () => {
  const fixture = await imageFixtures();
  const runtime = createRuntime(undefined, {browser: true, images: true});
  const api = nativeClient(() => runtime);
  const image = (data: Buffer) => ({type: 'image', mediaType: 'image/png', data: data.toString('base64')});
  const submit = (sessionId: string, content: unknown[]) => api.raw('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content}});
  try {
    await api.call('session/create', {request: {sessionId: 'image-boundary'}});
    const maximum = paddedPng(fixture.png, 20_000_000);
    assert.equal((await submit('image-boundary', [image(maximum)])).result.ok, true);
    const {events} = await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/image-boundary/events`))).json() as {events: Array<{type: string; data: unknown}>};
    assert.ok(events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('sha256:')));
    await api.call('session/create', {request: {sessionId: 'image-rejected'}});
    for (const [content, reason] of [
      [[image(paddedPng(fixture.png, 20_000_001))], 'IMAGE_TOO_LARGE'],
      [[image(maximum), image(paddedPng(fixture.png, 1_000_000))], 'IMAGES_TOO_LARGE'],
      [Array.from({length: 21}, () => image(fixture.png)), 'TOO_MANY_IMAGES'],
    ] as const) {
      const result = await submit('image-rejected', [...content]);
      assert.equal(result.result.error?.code, 'session/attachment-invalid');
      assert.equal(result.result.error?.details?.reason, reason);
    }
    const rejectedEvents = await (await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/sessions/image-rejected/events`))).json();
    assert.ok(!JSON.stringify(rejectedEvents).includes('sha256:'));
  } finally {await runtime.dispose();}
});
