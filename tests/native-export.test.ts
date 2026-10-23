import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync, strFromU8} from 'fflate';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session/types';
import {sessionFormatLogFilename} from '@weft/upstream/packages/session/session-format/src/filename.ts';
import type {SessionListValue} from '@deepseek-ai/dsh-api-session-controller/types';
import type {FileUploadValue} from '@deepseek-ai/dsh-client-file-upload/types';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

const base = (environment = 'default') => `/v1/tenants/${tenantId('alpha')}/environments/${environment}`;
const SESSION_LOG_FILENAME = sessionFormatLogFilename(SESSION_FORMAT_VERSION);
const endpoint = (sessionId: string, environment = 'default') => base(environment)+'/native/api/session.export?'+new URLSearchParams({sessionId, includeDescendants: 'true'});

test('native HEAD and streamed GET export original logs and referenced files without activating a cold Agent', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-export-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  const data = Uint8Array.from({length: 131_107}, (_, i) => i % 251);
  const readArchive = async () => {
    const head = await runtime.dispatchFetch(url('alpha', endpoint('exported')), {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/zip');
    assert.equal(head.headers.get('content-disposition'), 'attachment; filename="dsh-session-exported.zip"');
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const response = await runtime.dispatchFetch(url('alpha', endpoint('exported')));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const lines = strFromU8(entries[SESSION_LOG_FILENAME]!).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].id, 'exported');
    assert.match(JSON.stringify(lines), /EXPORT_REAL_PROMPT/);
    assert.ok(lines.some(line => line.type === 'turn/end'), 'the current writer flushes its completed turn');
    const file = Object.keys(entries).find(path => path.startsWith('files/') && path.endsWith('/invoice.bin'));
    assert.ok(file, 'the original archive includes the referenced upload');
    assert.deepEqual(entries[file], data);
    assert.equal(Object.keys(entries).length, 2);
  };
  try {
    await api.call('session/create', {request: {sessionId: 'exported'}});
    const commands = await api.call<{name: string}[]>('commands/list', {agentId: 'exported'});
    assert.ok(commands.some(command => command.name === 'export'));
    const execute = (line: string) => api.call<{result: {kind: string}}>('commands/execute', {agentId: 'exported', line, submittedAttachments: []});
    assert.equal((await execute('/export')).result.kind, 'success');
    assert.equal((await execute('/export /workspace/log.zip')).result.kind, 'error');
    const receipt = await api.call<FileUploadValue>('fileUploads/upload', {agentId: 'exported', request: {name: 'invoice.bin', data: Buffer.from(data).toString('base64')}});
    await api.call('session/prompt', {request: {sessionId: 'exported', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'EXPORT_REAL_PROMPT'}, {type: 'file', receiptId: receipt.receiptId}]}});
    await (await runtime.dispatchFetch(url('alpha', base()+'/sessions/exported/events'))).json();
    await readArchive();
    await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    const cold = async () => assert.ok((await api.call<SessionListValue>('session/list', {_request: {}})).items.every(item => !item.agentAvailable));
    await cold();
    await readArchive();
    await cold();
    const cancelled = await runtime.dispatchFetch(url('alpha', endpoint('exported')));
    await cancelled.body!.cancel();
    await readArchive();
    await cold();
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('native export rejects unsupported methods and invalid queries and isolates tenants and environments', async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'same'}});
    await api.call('session/rename', {request: {sessionId: 'same', title: 'PRIVATE_ALPHA_EXPORT'}});
    assert.equal((await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'other', name: 'Other'})})).status, 201);
    assert.equal((await runtime.dispatchFetch(url('alpha', endpoint('same', 'other')))).status, 404);
    await nativeClient(() => runtime, 'other').call('session/create', {request: {sessionId: 'same'}});
    const other = await runtime.dispatchFetch(url('alpha', endpoint('same', 'other')));
    assert.equal(other.status, 200);
    const archive = unzipSync(new Uint8Array(await other.arrayBuffer()));
    assert.doesNotMatch(strFromU8(archive[SESSION_LOG_FILENAME]!), /PRIVATE_ALPHA_EXPORT/);
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await runtime.dispatchFetch(url('beta', endpoint('same')), {method})).status, 403);
      assert.equal((await runtime.dispatchFetch(url('anonymous', endpoint('same')), {method})).status, 401);
      assert.equal((await runtime.dispatchFetch(url('alpha', endpoint('missing')), {method})).status, 404);
      for (const query of ['', '?sessionId=../escape', '?sessionId=same&includeDescendants=yes', '?sessionId=same&sessionId=missing', '?sessionId=same&includeDescendants=true&includeDescendants=false']) {
        const response = await runtime.dispatchFetch(url('alpha', base()+'/native/api/session.export'+query), {method});
        assert.equal(response.status, 400);
        if (method === 'HEAD') assert.equal((await response.arrayBuffer()).byteLength, 0);
      }
    }
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const response = await runtime.dispatchFetch(url('alpha', endpoint('same')), {method});
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  } finally {await runtime.dispose();}
});
