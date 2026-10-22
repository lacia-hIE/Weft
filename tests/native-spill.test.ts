import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId } from './helpers/miniflare.ts';
import type { WorkspaceOperation, WorkspaceScope } from '../packages/workspace/src/protocol.ts';
import { DATA_LAYOUT_VERSION } from '../packages/tenant/src/layout.ts';
import { nativeClient } from './helpers/native.ts';

/** The model calls each listed tool of the latest turn once; only model HTTP is scripted. */
function toolModel(turns: Record<string, {name: string; input: Record<string, unknown>}[]>) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const used: Record<string, number> = {};
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://runtime-model.test') throw new Error(`Unexpected runtime fixture request ${request.url}`);
    const body = await request.text();
    const turn = Object.keys(turns).findLast(marker => body.includes(marker));
    let call: {name: string; input: Record<string, unknown>} | undefined;
    if (turn !== undefined) {
      const index = used[turn] ?? 0;
      used[turn] = index + 1;
      call = turns[turn]![index];
    }
    const id = `${turn}-${used[turn ?? ''] ?? 0}`;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: call ? {type: 'tool_use', id, name: call.name, input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: call ? {type: 'input_json_delta', partial_json: JSON.stringify(call.input)} : {type: 'text_delta', text: 'RUNTIME_DONE'}}) +
      event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return outbound;
}

test('an oversized tool result spills into the workspace and the model sees where to read it', {timeout: 180_000}, async () => {
  const calls = {
    SPILL_ONE: [
      {name: 'bash', input: {command: 'seq 1 40000', description: 'Print many lines'}},
      {name: 'bash', input: {command: 'cat /workspace/.dsh/spill/.gitignore; tail -n 4 $(find /workspace/.dsh/spill -type f -name "*-bash.txt"); wc -l < $(find /workspace/.dsh/spill/output -type f -name "*-stdout.txt")', description: 'Inspect the spilled result'}},
    ],
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'spill-fixture', DEEPSEEK_BASE_URL: 'https://runtime-model.test/anthropic'}, outbound: toolModel(calls)});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'spill'}});
    const follow = await api.follow('spill');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'spill', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'SPILL_ONE'}]}});
    const results: string[] = [];
    for (;;) {
      const frame: SessionFollowFrame = await follow.next();
      if (frame.type !== 'event') continue;
      if (frame.event.type === 'tool/result') results.push(JSON.stringify(frame.event));
      if (frame.event.type === 'turn/end') break;
    }
    await follow.close();
    assert.equal(results.length, 2, results.join('\n'));
    // The model keeps the head and tail and is told where the whole result is.
    assert.match(results[0]!, /Full formatted result stored at: \/workspace\/\.dsh\/spill\/session-[0-9a-f]{12}\/[0-9a-f-]+-bash\.txt\./);
    assert.match(results[0]!, /Use read with offset\/limit, or grep this path/);
    assert.ok(results[0]!.length < 120_000, 'the inline result is cut to the token budget');
    // The shell kept the tail of a long output and saved all of it in the workspace.
    assert.match(results[0]!, /\[output truncated; full output: \/workspace\/\.dsh\/spill\/output\/[0-9a-f-]+-stdout\.txt\]/);
    // The full text is a workspace file the shell reads, and git ignores the spill directory.
    assert.match(results[1]!, /"text":"\*\\n/);
    assert.match(results[1]!, /40000\\n/);
    // `wc -l` of the saved output follows the tail's last line.
    assert.match(results[1]!, /\]40000\\n"/, 'the saved output holds every line');
  } finally {
    await runtime.dispose();
  }
});

test('the spill cleanup removes only expired spilled files and the directories it empties', {timeout: 120_000}, async () => {
  const runtime = createRuntime();
  try {
    const namespace = await runtime.getDurableObjectNamespace('WORKSPACES', 'alpha');
    const scope: WorkspaceScope = {tenantId: tenantId('alpha'), workspaceId: 'sweep'};
    const workspace = namespace.get(namespace.idFromName(JSON.stringify([DATA_LAYOUT_VERSION, 'workspace', scope.tenantId, 'default', scope.workspaceId]))) as unknown as {call(scope: WorkspaceScope, operation: WorkspaceOperation): Promise<Response>};
    const call = async (operation: WorkspaceOperation) => {
      const response = await workspace.call(scope, operation);
      return {status: response.status, body: await response.json() as {value?: unknown; code?: string}};
    };
    for (const path of ['/workspace/.dsh/spill/.gitignore', '/workspace/.dsh/spill/session-a/one.txt', '/workspace/.dsh/spill/output/two/part-1.txt', '/workspace/notes.txt']) {
      assert.equal((await call({type: 'write', path, content: 'x'})).status, 200);
    }
    // Nothing is older than the cutoff yet.
    assert.deepEqual((await call({type: 'sweep', path: '/workspace/.dsh/spill', before: Date.now() - 60_000})).body.value, {removed: 0});
    assert.deepEqual((await call({type: 'sweep', path: '/workspace/.dsh/spill', before: Date.now() + 60_000})).body.value, {removed: 2});
    assert.equal((await call({type: 'stat', path: '/workspace/.dsh/spill/session-a'})).body.value, null, 'an emptied session directory is pruned');
    assert.equal((await call({type: 'stat', path: '/workspace/.dsh/spill/output'})).body.value, null);
    assert.ok((await call({type: 'stat', path: '/workspace/.dsh/spill/.gitignore'})).body.value, 'the ignore file stays');
    assert.ok((await call({type: 'stat', path: '/workspace/notes.txt'})).body.value);
    // Only spilled output is ever swept.
    assert.equal((await call({type: 'sweep', path: '/workspace', before: Date.now() + 60_000})).body.code, 'FS_SANDBOX_DENIED');
    assert.ok((await call({type: 'stat', path: '/workspace/notes.txt'})).body.value);
  } finally {
    await runtime.dispose();
  }
});
