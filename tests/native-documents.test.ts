import assert from 'node:assert/strict';
import {test} from 'node:test';
import {zipSync, strToU8} from 'fflate';
import {WorkerDocuments, DocumentConversionError, presentationHtml, MAX_DOCUMENT_BYTES, type DocumentResult} from '../packages/native-documents/src/converter.ts';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';

test('Worker document conversion preserves binary Office input and delegates supported files to the Cloudflare binding', async () => {
  const bytes = Uint8Array.from([0x50, 0x4b, 0, 255, 1, 2]);
  let calls = 0;
  const ai = {toMarkdown(file?: MarkdownDocument) {
    if (!file) return {supported: async () => [{extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}]};
    calls++;
    return (async () => {
      assert.equal(file.name, 'report.docx');
      assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), bytes);
      return {format: 'markdown', data: '# Report', mimeType: file.blob.type, tokens: 3};
    })();
  }} as unknown as Ai;
  const documents = new WorkerDocuments(ai);
  assert.equal((await documents.convert('report.docx', bytes)).markdown, '# Report');
  await documents.convert('report.docx', bytes); assert.equal(calls, 1);
  await assert.rejects(documents.convert('report.docx', new Uint8Array(MAX_DOCUMENT_BYTES + 1)), /10 MiB/);
  await assert.rejects(documents.convert('legacy.doc', bytes), /does not support/);
  await assert.rejects(new WorkerDocuments(undefined).convert('report.docx', bytes), /binding is required/);
});

test('PPTX slide text is extracted in numeric slide order inside the Worker without processing external entities', () => {
  const slide = (text: string) => strToU8(`<p:sld><a:t>${text}</a:t></p:sld>`);
  const bytes = zipSync({'ppt/slides/slide10.xml': slide('Tenth'), 'ppt/slides/slide2.xml': slide('Second'), 'ppt/media/ignored.txt': strToU8('not slide text')});
  const html = presentationHtml(bytes);
  assert.ok(html.indexOf('Second') < html.indexOf('Tenth'));
  assert.doesNotMatch(html, /not slide text/);
  assert.throws(() => presentationHtml(zipSync({'ppt/slides/slide1.xml': new Uint8Array(17 * 1024 * 1024)})), /extraction limit/);
});

test('document conversions coalesce, persist across converters, do not cache failures, and release timed-out work', async () => {
  const rows = new Map<string, DocumentResult>();
  const cache = {get: (key: string) => rows.get(key), put: (key: string, value: DocumentResult) => {rows.set(key, value);}};
  let calls = 0, release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const ai = {toMarkdown(file?: MarkdownDocument) {
    if (!file) return {supported: async () => [{extension: 'html', mimeType: 'text/html'}]};
    calls++; return barrier.then(() => ({format: 'markdown', data: '# Shared', mimeType: 'text/html', tokens: 2}));
  }} as unknown as Ai;
  const bytes = new TextEncoder().encode('hello');
  const documents = new WorkerDocuments(ai, cache);
  const a = documents.convert('a.html', bytes), b = documents.convert('a.html', bytes);
  release!();
  assert.deepEqual((await Promise.all([a, b])).map(value => value.cache), ['miss', 'shared']); assert.equal(calls, 1);
  assert.equal((await new WorkerDocuments(ai, cache).convert('a.html', bytes)).cache, 'hit'); assert.equal(calls, 1);
  const broken = {toMarkdown(file?: MarkdownDocument) {return file ? Promise.resolve({format: 'error', error: 'Encrypted document'}) : {supported: async () => [{extension: 'pdf', mimeType: 'application/pdf'}]};}} as unknown as Ai;
  await assert.rejects(new WorkerDocuments(broken, cache).convert('encrypted.pdf', bytes), error => error instanceof DocumentConversionError && error.code === 'DOCUMENT_CONVERSION_FAILED' && !error.retryable && error.message.includes('Encrypted'));
  const hanging = {toMarkdown: () => ({supported: () => new Promise(() => {})})} as unknown as Ai;
  const timed = new WorkerDocuments(hanging, cache, 5);
  await assert.rejects(timed.convert('timeout.html', bytes), error => error instanceof DocumentConversionError && error.code === 'DOCUMENT_TIMEOUT' && error.retryable);
  await assert.rejects(timed.convert('timeout.html', bytes), error => error instanceof DocumentConversionError && error.code === 'DOCUMENT_TIMEOUT');
  const four = Promise.allSettled(['1','2','3','4'].map(name => timed.convert(name+'.html', bytes)));
  await assert.rejects(timed.convert('5.html', bytes), error => error instanceof DocumentConversionError && error.code === 'DOCUMENT_BUSY' && error.retryable);
  assert.ok((await four).every(result => result.status === 'rejected'));
  assert.equal(rows.size, 1);
});

test('document SQLite cache survives a cold WorkspaceDO and never shares entries across tenants or environments', {timeout: 90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-doc-cache-'));
  const options = {browser: true, scriptPath: 'dist/documents-worker.js'};
  let runtime = createRuntime(directory, options);
  const scope = {tenantId: tenantId('alpha'), environmentId: 'default', workspaceId: 'default'};
  const convert = async (target = scope) => {
    const response = await runtime.dispatchFetch(url('alpha', '/_test/documents'), {method: 'POST', body: JSON.stringify({scope: target, name: 'cache.html', content: '<h1>Persistent conversion</h1>'})});
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as DocumentResult & {cache: string};
  };
  try {
    assert.equal((await convert()).cache, 'miss');
    await runtime.dispose(); runtime = createRuntime(directory, options);
    const restored = await convert(); assert.equal(restored.cache, 'hit'); assert.match(restored.markdown, /Persistent conversion/);
    assert.equal((await convert({...scope, environmentId: 'other'})).cache, 'miss');
    assert.equal((await convert({...scope, tenantId: tenantId('beta')})).cache, 'miss');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('native document tool runs in Worker-only mode, saves Markdown and refuses output overwrites', {timeout: 90000}, async () => {
  let requests = 0;
  const runtime = createRuntime(undefined, {browser: true, scriptPath: 'dist/documents-worker.js', bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'documents-fixture', DEEPSEEK_BASE_URL: 'https://documents.test/anthropic'}, outbound: async () => {
    requests++;
    if (requests === 1 || requests === 2) return nativeFixtureResponse({name: 'document_to_markdown', input: {file_path: '/workspace/report.html', output_path: '/workspace/report.md'}});
    return nativeFixtureResponse();
  }});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  try {
    await api.call('session/create', {request: {sessionId: 'documents'}});
    const response = await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: '/workspace/report.html', content: '<h1>OFFICE_WORKER_CONTENT</h1>', expectedVersion: null})});
    assert.equal(response.status, 200);
    const follow = await api.follow('documents'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'documents', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Convert the Office report'}]}});
    const events = [];
    for (;;) {const frame = await follow.next(); if (frame.type === 'event') {events.push(frame.event); if (frame.event.type === 'turn/end') break;}}
    await follow.close();
    const results = JSON.stringify(events.filter(event => event.type === 'tool/result'));
    assert.match(results, /OFFICE_WORKER_CONTENT/);
    assert.match(results, /Read the existing file before replacing it/);
    const markdown = await runtime.dispatchFetch(url('alpha', base+'/workspaces/default/files?path=/workspace/report.md'));
    assert.equal(markdown.status, 200); assert.match(await markdown.text(), /OFFICE_WORKER_CONTENT/);
  } finally {await runtime.dispose();}
});
