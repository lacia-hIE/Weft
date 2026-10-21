import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; the minimal preset's persistent bash runs over the official terminal service. */
function bashModel(commands: string[]) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  let index = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://persistent-model.test') throw new Error(`Unexpected persistent shell fixture outbound request ${request.url}`);
    const body = JSON.stringify(await request.json());
    // Title requests do not carry the prompt's tool loop.
    if (!body.includes('PERSISTENT_TASK')) return reply(event, {type: 'text', text: ''}, {type: 'text_delta', text: 'Title'}, 'end_turn');
    const command = commands[index++];
    return command === undefined
      ? reply(event, {type: 'text', text: ''}, {type: 'text_delta', text: 'PERSISTENT_DONE'}, 'end_turn')
      : reply(event, {type: 'tool_use', id: `bash-${index}`, name: 'bash', input: {}}, {type: 'input_json_delta', partial_json: JSON.stringify({command})}, 'tool_use');
  };
  return {outbound};
}

function reply(event: (type: string, value: object) => string, block: object, delta: object, stop: string) {
  return new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: block}) + event('content_block_delta', {index: 0, delta}) +
    event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: stop}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}},
  );
}

test('the minimal preset keeps shell state across persistent bash commands', {timeout: 180_000}, async () => {
  const commands = [
    "export GREETING=hi; LOCAL=kept; f() { echo fn-$1; }; alias hey='echo alias-ok'; mkdir -p persist/dir && cd persist/dir && false",
    'echo "$GREETING|$LOCAL|$PWD"; f x; hey',
    "cat <<'EOF'\nline one\nline two\nEOF",
    'echo $((6*7)) > out.txt && cat out.txt',
    'echo escaped > /etc/blocked',
  ];
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'persistent-fixture', DEEPSEEK_BASE_URL: 'https://persistent-model.test/anthropic'}, outbound: bashModel(commands).outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'persistent', agentPreset: 'minimal'}});
    const follow = await api.follow('persistent');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'persistent', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'PERSISTENT_TASK'}]}});
    const results: {data: {message: {content: {text?: string}[]}}}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; if (frame.event.type === 'tool/result') results.push(frame.event as never); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    const texts = results.map(event => event.data.message.content.map(part => part.text ?? '').join(''));
    assert.equal(texts.length, commands.length, JSON.stringify(texts));
    assert.match(texts[0]!, /1/, 'the exit status of the last command is reported');
    assert.match(texts[1]!, /hi\|kept\|\/workspace\/persist\/dir/);
    assert.match(texts[1]!, /fn-x/);
    assert.match(texts[1]!, /alias-ok/);
    assert.match(texts[2]!, /line one\s+line two/);
    assert.match(texts[3]!, /42/);
    assert.match(texts[4]!, /blocked by the workspace-write sandbox/);
  } finally {
    await runtime.dispose();
  }
});
