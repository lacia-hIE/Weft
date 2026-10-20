import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionFollowFrame, SessionPage, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('session/fork seeds a new SessionDO from the original completed-turn prefix and keeps it in the same Workspace', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const turn = async (sessionId: string, text: string) => {
    const follow = await api.follow(sessionId);
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
    for (;;) {const frame: SessionFollowFrame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await follow.close();
  };
  const events = async (sessionId: string) => {
    const projections = await api.call<{asOfSeq: number}>('session/projections', {request: {sessionId}});
    return (await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId}, throughSeq: projections.asOfSeq}})).records.map(record => record.event);
  };
  try {
    await api.call('session/create', {request: {sessionId: 'origin'}});
    assert.equal((await api.raw('session/fork', {request: {sessionId: 'origin'}})).result.error?.code, 'session/fork-unavailable', 'a Session without a completed turn has no fork boundary');
    await turn('origin', 'ORIGIN_PROMPT');

    const {sessionId} = await api.call<{sessionId: string}>('session/fork', {request: {sessionId: 'origin'}});
    assert.notEqual(sessionId, 'origin');
    const inherited = await events(sessionId);
    assert.ok(inherited.some(event => event.type === 'user/message' && JSON.stringify(event).includes('ORIGIN_PROMPT')), 'the fork carries the parent prefix');
    assert.ok(inherited.some(event => event.type === 'session/end-seed'), 'the original seed marker closes the inherited prefix');
    const listed = await api.call<SessionListValue>('session/list', {_request: {}});
    const fork = listed.items.find(item => item.sessionId === sessionId);
    assert.ok(fork, 'the fork is listed');

    await turn(sessionId, 'FORK_PROMPT');
    assert.ok((await events(sessionId)).some(event => event.type === 'user/message' && JSON.stringify(event).includes('FORK_PROMPT')));
    assert.ok(!(await events('origin')).some(event => event.type === 'user/message' && JSON.stringify(event).includes('FORK_PROMPT')), 'the parent is unchanged');

    const {workspace} = await api.call<{workspace: {sessionIds: string[]}}>('workspace/initializeDefault', {});
    assert.ok(workspace.sessionIds.includes(sessionId) && workspace.sessionIds.includes('origin'), 'the fork joins its parent Workspace');
  } finally {
    await runtime.dispose();
  }
});
