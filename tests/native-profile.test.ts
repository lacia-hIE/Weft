import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, FIXTURE_TITLE } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the official Web profile is composed with an overlay that classifies every host row', async () => {
  // The module the build composed and checked; the Worker bundles exactly its enabled rows.
  const profile = await import('../.generated/official-profile.mjs') as {overlayProblems(): string[]; enabledEntries(): {id: string}[]; enabledModuleNames(): string[]};
  assert.deepEqual(profile.overlayProblems(), []);
  assert.ok(profile.enabledEntries().some(entry => entry.id === 'llm-retry'));
  assert.ok(profile.enabledModuleNames().every(name => !name.startsWith('@deepseek-ai/dsh-client-')), 'browser rows are served by the Boot Graph');
});

/** Only model HTTP is scripted; retry, title, stats and outline rows are the official profile's. */
test('profile rows loaded by the Session Loader retry provider failures, title the Session and fold stats and outline', {timeout: 120_000}, async () => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  let turns = 0;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://profile-model.test') throw new Error(`Unexpected outbound ${request.url}`);
    await request.json();
    if (++turns === 1) return new Response('overloaded', {status: 503});
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'PROFILE_DONE'}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  const runtime = createRuntime(undefined, {browser: true, outbound, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'profile-fixture', DEEPSEEK_BASE_URL: 'https://profile-model.test/anthropic'}});
  const api = nativeClient(() => runtime);
  try {
    // The original retry row reads the route's policy from the provider settings, live.
    const described = await api.call<{namespaces: {ns: string; revision: number}[]}>('settings/describe', {});
    const revision = described.namespaces.find(row => row.ns === 'llm-deepseek')!.revision;
    await api.call('settings/update', {ns: 'llm-deepseek', patch: {retryPolicy: {mode: 'normal', maxRetries: 1}}, expectedRevision: revision});
    await api.call('session/create', {request: {sessionId: 'profile'}});
    const follow = await api.follow('profile');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'profile', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'PROFILE_TASK'}]}});
    const committed: {type: string}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; committed.push(frame.event); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    assert.match(JSON.stringify(committed), /PROFILE_DONE/, 'the retried request completed the turn');
    assert.equal(turns, 2, 'one failed attempt and one retry');

    const projections = await api.call<{values: {sessionStats?: unknown; turnOutline?: unknown}}>('session/projections', {request: {sessionId: 'profile'}});
    assert.ok(projections.values.sessionStats, 'session stats fold');
    assert.ok(projections.values.turnOutline, 'turn outline fold');
    // The fallback title commits first; the LLM title follows the turn.
    let titled = '';
    for (let attempt = 0; attempt < 50 && !titled.includes(FIXTURE_TITLE); attempt++) {
      titled = JSON.stringify((await api.call<{values: {title?: unknown}}>('session/projections', {request: {sessionId: 'profile'}})).values.title ?? null);
      if (!titled.includes(FIXTURE_TITLE)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(titled, new RegExp(FIXTURE_TITLE), 'the first-prompt LLM title row named the Session');
  } finally {
    await runtime.dispose();
  }
});
