import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
const outbound: V4FetchHandler = async request => {
  if (new URL(request.url).origin !== 'https://profile-model.test') throw new Error(`Unexpected profile settings fixture request ${request.url}`);
  await request.text();
  return new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'PROFILE_DONE'}}) +
    event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}},
  );
};

test('official profile rows with live fields get settings forms whose edits reach a live Session', {timeout: 180_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'profile-fixture', DEEPSEEK_BASE_URL: 'https://profile-model.test/anthropic'}, outbound});
  const api = nativeClient(() => runtime);
  try {
    const row = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(ns => ns.ns === 'session-log-deepseek');
    assert.ok(row, 'the official request-log row is listed from its own schema');
    assert.equal((row.value as {enabled?: boolean}).enabled, true);
    await api.call('session/create', {request: {sessionId: 'profile'}});
    const follow = await api.follow('profile');
    assert.equal((await follow.next()).type, 'snapshot');
    const turn = async (text: string) => {
      await api.call('session/prompt', {request: {sessionId: 'profile', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      const types: string[] = [];
      for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; types.push(frame.event.type); if (frame.event.type === 'turn/end') break;}
      return types;
    };
    assert.ok((await turn('FIRST')).some(type => type.startsWith('session-log-deepseek/')), 'the row runs with its profile configuration');
    const changed = await api.call<SettingsNamespaceView>('settings/update', {ns: 'session-log-deepseek', patch: {enabled: false}, expectedRevision: row.revision});
    assert.equal((changed.value as {enabled?: boolean}).enabled, false);
    // The first turn's delivery may be acknowledged after it ends; the second turn itself logs nothing.
    const second = await turn('SECOND');
    assert.ok(!second.slice(second.indexOf('turn/start')).some(type => type.startsWith('session-log-deepseek/')), 'the next turn runs with the edited configuration');
    await follow.close();
  } finally {
    await runtime.dispose();
  }
});
