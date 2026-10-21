import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** Only model HTTP is scripted; the official tools presentation runs each program in a Dynamic Worker. */
function ptcModel(programs: {code: string; timeoutMs?: number}[], requests: {tools?: {name: string}[]}[]) {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  let index = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://ptc-model.test') throw new Error(`Unexpected PTC fixture outbound request ${request.url}`);
    const body = await request.json() as {tools?: {name: string}[]; system?: unknown};
    if (JSON.stringify(body).includes('run_code')) requests.push(body);
    const args = programs[index++];
    const tool = args !== undefined;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: `run-${index}`, name: 'run_code', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify({description: "Run a program", ...args})} : {type: 'text_delta', text: 'PTC_DONE'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

test('PTC mode runs TypeScript programs in Dynamic Workers against the session tools', {timeout: 180_000}, async () => {
  const requests: {tools?: {name: string}[]}[] = [];
  const programs = [
    {code: 'const names: string[] = Object.keys(tools).sort();\nconsole.log("tools", names.join(","));\nreturn {count: names.length, typed: (6 * 7) as number};'},
    {code: 'await tools.write({file_path: "/workspace/ptc/out.txt", content: "ptc-wrote"});\nconst read = await tools.read({file_path: "/workspace/ptc/out.txt"});\nreturn JSON.stringify(read).includes("ptc-wrote");'},
    {code: 'try { await tools.no_such_tool_here({}); } catch (error) { console.log("missing", typeof error); }\ntry { await tools.read({file_path: 1}); } catch (error) { console.log("rejected", error instanceof ToolCallError, (error as any).toolName); }\nreturn null;'},
    {code: 'throw new Error("PROGRAM_BOOM");'},
    {code: 'await new Promise(resolve => setTimeout(resolve, 10_000));', timeoutMs: 500},
    {code: 'const response = await fetch("https://example.com/");\nreturn response.status;'},
    {code: 'return () => 1;'},
  ];
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'ptc-fixture', DEEPSEEK_BASE_URL: 'https://ptc-model.test/anthropic'}, outbound: ptcModel(programs, requests).outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'ptc', agentPreset: 'ptc'}});
    const follow = await api.follow('ptc');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'ptc', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'PTC_TASK'}]}});
    const results: {data: {message: {content: {text?: string}[]}}}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; if (frame.event.type === 'tool/result') results.push(frame.event as never); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    const texts = results.map(event => JSON.stringify(event.data.message.content));
    assert.equal(texts.length, programs.length, JSON.stringify(results));
    assert.ok(requests[0]?.tools?.some(tool => tool.name === 'run_code'), 'the model sees run_code');
    assert.ok(!requests[0]?.tools?.some(tool => tool.name === 'bash' || tool.name === 'read'), 'native tool schemas are presented through the SDK instead');
    assert.match(texts[0]!, /tools [a-z_,]*read/);
    assert.match(texts[0]!, /typed\\": 42/);
    assert.match(texts[1]!, /true/);
    assert.match(texts[2]!, /missing/);
    assert.match(texts[2]!, /rejected true read/);
    assert.match(texts[3]!, /exception.*PROGRAM_BOOM/);
    assert.match(texts[4]!, /timeout/);
    assert.doesNotMatch(texts[5]!, /200/);
    assert.match(texts[6]!, /invalid-output/);
  } finally {
    await runtime.dispose();
  }
});
