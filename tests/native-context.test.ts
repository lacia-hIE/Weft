import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the original skill catalog lists user-invocable skills from the environment volume', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    const written = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`), {
      method: 'PUT', headers: {'content-type': 'application/json'},
      body: JSON.stringify({path: '.agents/skills/release-notes/SKILL.md', content: '---\nname: release-notes\ndescription: Draft release notes from merged changes.\n---\nWrite concise release notes.', expectedVersion: null}),
    });
    assert.equal(written.status, 200);
    await api.call('session/create', {request: {sessionId: 'skills'}});
    const listed = await api.call<{skills: {name: string; description: string}[]}>('skills/list', {request: {sessionId: 'skills'}});
    assert.deepEqual(listed.skills.map(skill => [skill.name, skill.description]), [['release-notes', 'Draft release notes from merged changes.']]);
  } finally {
    await runtime.dispose();
  }
});

test('@ file references enumerate the environment volume with the original ranking', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    for (const path of ['docs/guide.md', 'docs/notes.txt', 'src/app.ts', 'node_modules/pkg/index.js', '.hidden/secret.md']) {
      const written = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`), {
        method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path, content: path, expectedVersion: null}),
      });
      assert.equal(written.status, 200);
    }
    await api.call('session/create', {request: {sessionId: 'refs'}});
    const list = (query: string) => api.call<{path: string; kind: string}[]>('fileReferences/list', {agentId: 'refs', query});
    assert.deepEqual(await list(''), [{path: 'docs', kind: 'directory'}, {path: 'src', kind: 'directory'}]);
    assert.deepEqual(await list('docs/'), [{path: 'docs/guide.md', kind: 'file'}, {path: 'docs/notes.txt', kind: 'file'}]);
    assert.deepEqual((await list('gui')).map(candidate => candidate.path), ['docs/guide.md']);
    assert.deepEqual(await list('index'), [], 'excluded directories are not indexed');
  } finally {
    await runtime.dispose();
  }
});

test('@ Session references list and inline other Sessions of the environment through the original resolver', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const turn = async (sessionId: string, text: string) => {
    const follow = await api.follow(sessionId);
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
    const events: {type: string}[] = [];
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type !== 'event') continue; events.push(frame.event); if (frame.event.type === 'turn/end') break;}
    await follow.close();
    return events;
  };
  try {
    await api.call('session/create', {request: {sessionId: 'source'}});
    await turn('source', 'SOURCE_SESSION_FACT');
    await api.call('session/create', {request: {sessionId: 'reader'}});
    const candidates = await api.call<{sessionId: string; mention: string}[]>('sessionReferenceResolver/candidates', {agentId: 'reader', query: ''});
    assert.deepEqual(candidates.map(candidate => candidate.sessionId), ['source'], 'other Sessions are candidates; the caller is not');
    const events = await turn('reader', `Summarize ${candidates[0]!.mention}`);
    assert.ok(events.some(event => event.type === 'user/message' && JSON.stringify(event).includes('SOURCE_SESSION_FACT')), 'the referenced Session reaches the logged model context');
  } finally {
    await runtime.dispose();
  }
});

test('official agent-instructions read AGENTS.md from the environment volume into the native model context', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    const written = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/workspaces/default/files`), {
      method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: 'AGENTS.md', content: 'PROJECT_RULE_ALPHA: answer in haiku.', expectedVersion: null}),
    });
    assert.equal(written.status, 200);
    await api.call('session/create', {request: {sessionId: 'context'}});
    follow = await api.follow('context');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'context', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'hello'}]}});
    const committed: {type: string}[] = [];
    for (;;) {
      const frame: SessionFollowFrame = await follow.next();
      if (frame.type !== 'event') continue;
      committed.push(frame.event);
      if (frame.event.type === 'turn/end') break;
    }
    assert.match(JSON.stringify(committed.at(-1)), /"kind":"(completed|stop|end)/, JSON.stringify(committed.at(-1)));
    assert.ok(committed.some(event => event.type === 'user/message' && JSON.stringify(event).includes('PROJECT_RULE_ALPHA')), 'the instruction file reaches the logged model context');
  } finally {
    await follow?.close();
    await runtime.dispose();
  }
});
