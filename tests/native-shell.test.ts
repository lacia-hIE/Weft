import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; the original bash tool, executor and job registry run over the Computer shell. */
function shellModel(calls: Record<string, unknown>[]) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  let index = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin === 'https://curl-target.test') return new Response('CurlReachedAlpha');
    if (new URL(request.url).origin !== 'https://shell-model.test') throw new Error(`Unexpected shell fixture outbound request ${request.url}`);
    await request.json();
    const args = calls[index++];
    const tool = args !== undefined;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: `bash-${index}`, name: 'bash', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify(args)} : {type: 'text_delta', text: 'SHELL_DONE'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

async function shellTurn(calls: Record<string, unknown>[], inspect?: (api: ReturnType<typeof nativeClient>, runtime: ReturnType<typeof createRuntime>) => Promise<void>, prepare?: (runtime: ReturnType<typeof createRuntime>) => Promise<void>): Promise<string> {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'shell-fixture', DEEPSEEK_BASE_URL: 'https://shell-model.test/anthropic'}, outbound: shellModel(calls).outbound});
  const api = nativeClient(() => runtime);
  try {
    await prepare?.(runtime);
    await api.call('session/create', {request: {sessionId: 'shell'}});
    const follow = await api.follow('shell');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'shell', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'SHELL_TASK'}]}});
    const committed: {type: string}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; committed.push(frame.event); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    await inspect?.(api, runtime);
    return JSON.stringify(committed.filter(event => event.type === 'tool/result'));
  } finally {
    await runtime.dispose();
  }
}

const read = async (runtime: ReturnType<typeof createRuntime>, path: string) => runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files?path=${encodeURIComponent(path)}`));

test('the original bash tool runs commands in the environment shell against the same workspace volume', {timeout: 120_000}, async () => {
  const result = await shellTurn([{command: 'mkdir -p notes && echo shell-wrote > notes/out.txt && cat notes/out.txt && echo $((6*7)) && pwd', description: 'Write and read a file'}], async (_api, runtime) => {
    const file = await read(runtime, 'notes/out.txt');
    assert.equal(file.status, 200, await file.clone().text());
    assert.match(await file.text(), /shell-wrote/, 'Weft file APIs see the shell write');
  });
  assert.match(result, /shell-wrote/);
  assert.match(result, /42/);
  assert.match(result, /\/workspace/);
});

test('the shell cannot touch Weft attachment storage, symlink, or write outside the workspace volume', {timeout: 120_000}, async () => {
  const probes = [
    'cat /workspace/.weft/attachments/v1/anything',
    'echo private > /workspace/.weft/x',
    'echo escaped > /etc/x',
    'ln -s /etc notes-link',
    'echo scratch > /tmp/ok && cat /tmp/ok',
  ];
  const result = JSON.parse(await shellTurn(probes.map(command => ({command, description: 'Probe the boundary'})), async (_api, runtime) => {
    assert.equal((await read(runtime, '.weft/x')).status >= 400, true, 'nothing was written into attachment storage');
  })) as {data: {message: {content: {text: string}[]}}}[];
  const texts = result.map(event => event.data.message.content.map(part => part.text).join(''));
  assert.equal(texts.length, probes.length);
  // Existence probes are refused too, so the private area reads as absent to shell commands.
  assert.match(texts[0]!, /attachment storage is not accessible|No such file or directory/);
  assert.match(texts[1]!, /attachment storage is not accessible|cannot open redirect target/);
  assert.match(texts[2]!, /blocked by the workspace-write sandbox/);
  assert.match(texts[2]!, /escalation available/, 'the original bash tool offers an approved escalation');
  assert.match(texts[3]!, /symlinks are not supported/);
  assert.match(texts[4]!, /scratch/, 'scratch space stays writable');
});

test('background bash commands are tracked by the original job registry and listed through job/list', {timeout: 120_000}, async () => {
  const result = await shellTurn([{command: 'echo background-done', description: 'Run in background', run_in_background: true}], async api => {
    const stream = await api.stream<{jobs?: unknown[]; rows?: unknown[]}>('job/list', {request: {sessionId: 'shell'}});
    const frame = await stream.next();
    await stream.close();
    assert.match(JSON.stringify(frame), /echo background-done|Run in background/);
  });
  assert.match(result, /job/i);
});

test('curl in the shell reaches public HTTPS through the Dynamic Worker egress', {timeout: 120_000}, async () => {
  const result = await shellTurn([{command: 'curl -s https://curl-target.test/page', description: 'Fetch a page'}]);
  assert.match(result, /CurlReachedAlpha/);
});

test('a shell write gives the file a new version, so a stale Weft write is refused', {timeout: 120_000}, async () => {
  const files = `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`;
  let staleVersion = '';
  const result = await shellTurn([{command: 'echo shell-changed > versioned.txt && cat versioned.txt', description: 'Change a file'}], async (_api, runtime) => {
    const stale = await runtime.dispatchFetch(url('alpha', files), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: 'versioned.txt', content: 'weft overwrite', expectedVersion: staleVersion})});
    assert.equal(stale.status, 409, await stale.clone().text());
    assert.match(await (await read(runtime, 'versioned.txt')).text(), /shell-changed/);
  }, async runtime => {
    const created = await runtime.dispatchFetch(url('alpha', files), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: 'versioned.txt', content: 'original', expectedVersion: null})});
    assert.equal(created.status, 200);
    staleVersion = ((await created.json()) as {value: {version: string}}).value.version;
  });
  assert.match(result, /shell-changed/);
});
