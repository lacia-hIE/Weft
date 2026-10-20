import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

const searchKeys: string[] = [];

/** Model HTTP and the fetched page are scripted; web_fetch, its policy and the HTML conversion are original. */
function webModel(target: string, tool = 'web_fetch') {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.origin === 'https://web-model.test' && url.pathname === '/anthropic/v1/messages' && request.headers.get('accept') === 'application/json') {
      searchKeys.push(request.headers.get('x-api-key') ?? '');
      return Response.json({content: [
        {type: 'server_tool_use', id: 'srv', name: 'web_search', input: {query: 'weft'}},
        {type: 'web_search_tool_result', tool_use_id: 'srv', content: [{type: 'web_search_result', url: 'https://result.test/a', title: 'SearchResultAlpha', encrypted_content: '', page_age: null}]},
        {type: 'text', text: 'summary'},
      ]});
    }
    if (url.origin === 'https://page.test') return new Response('<html><body><h1>Release notes</h1><p>PageBodyAlpha</p></body></html>', {headers: {'content-type': 'text/html; charset=utf-8'}});
    if (url.origin !== 'https://web-model.test') throw new Error(`Unexpected web fixture outbound request ${request.url}`);
    const body = JSON.stringify(await request.json());
    const call = !body.includes('tool_result');
    const args = JSON.stringify(tool === 'web_fetch' ? {url: target} : {queries: [target]});
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: call ? {type: 'tool_use', id: 'web', name: tool, input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: call ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text: 'READ'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

async function fetchTurn(target: string, tool = 'web_fetch'): Promise<string> {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'web-fixture', DEEPSEEK_BASE_URL: 'https://web-model.test/anthropic'}, outbound: webModel(target, tool).outbound});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'web'}});
    const follow = await api.follow('web');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'web', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'FETCH_TASK'}]}});
    const committed: {type: string}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; committed.push(frame.event); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    return JSON.stringify(committed.filter(event => event.type === 'tool/result'));
  } finally {
    await runtime.dispose();
  }
}

test('web_fetch reads a public page through workerd and converts its HTML with the original tool', {timeout: 90_000}, async () => {
  const result = await fetchTurn('https://page.test/notes');
  assert.match(result, /PageBodyAlpha/);
  assert.match(result, /# Release notes/, 'the original turndown conversion produces markdown');
});

test('web_fetch refuses non-public IP literal targets before any request', {timeout: 90_000}, async () => {
  const result = await fetchTurn('http://127.0.0.1:8787/');
  assert.match(result, /non-public IP address/);
  assert.doesNotMatch(result, /PageBodyAlpha/);
});

test('web_search queries DeepSeek with the environment model key resolved through the native credential seam', {timeout: 90_000}, async () => {
  const result = await fetchTurn('weft release', 'web_search');
  assert.match(result, /SearchResultAlpha/);
  assert.deepEqual(searchKeys, ['web-fixture'], 'the search request carries the key saved in the environment Models settings');
});
