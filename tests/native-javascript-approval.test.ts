import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {RemoteEventDownlinkFrame} from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import {createRuntime} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeFixtureResponse} from './helpers/native-plugin-model.ts';

test('durable JavaScript approval uses the original DSH waterfall and resumes the exact waiting call', {timeout: 90000}, async () => {
  const tasks: {id: string; status: string; pending: {callId: string}[]}[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {try {collect(JSON.parse(value));} catch {} return;}
    if (!value || typeof value !== 'object') return;
    if ('id' in value && 'status' in value && 'pending' in value) tasks.push(value as typeof tasks[number]);
    else for (const item of Object.values(value)) collect(item);
  };
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'javascript-approval-fixture', DEEPSEEK_BASE_URL: 'https://javascript-approval.test/anthropic'}, outbound: async request => {
    tasks.length = 0;
    const body = await request.json() as {messages: unknown}; collect(body.messages);
    const task = tasks.at(-1);
    if (!task) return nativeFixtureResponse({name: 'javascript_task', input: {operation: 'start', source: `import {request} from 'ws:approval'; export default async () => {const answer = await request('Approve the durable Worker report'); return {approved: answer.approved};}`}});
    if (task.status === 'waiting') return nativeFixtureResponse({name: 'javascript_task', input: {operation: 'approve', id: task.id, callId: task.pending[0]!.callId}});
    if (task.status === 'running') return nativeFixtureResponse({name: 'javascript_task', input: {operation: 'status', id: task.id}});
    assert.equal(task.status, 'completed');
    return nativeFixtureResponse();
  }});
  const api = nativeClient(() => runtime);
  const events = await api.events();
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    const ready = await events.next(); if (ready.type !== 'ready') throw new Error('Missing native event connection');
    await api.call('session/create', {request: {sessionId: 'javascript-approval'}});
    follow = await api.follow('javascript-approval'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'javascript-approval', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Start and approve a durable report'}]}});
    let question: RemoteEventDownlinkFrame;
    do question = await events.next(); while (question.type !== 'waterfall');
    assert.equal(question.event, 'approval/request');
    assert.match(JSON.stringify(question.request), /Approve the durable Worker report/);
    await api.call('$events/result', {clientId: ready.clientId, eventId: question.eventId, outcome: {kind: 'result', value: 'allowed-once'}});
    const log = [];
    for (;;) {const frame = await follow.next(); if (frame.type === 'event') {log.push(frame.event); if (frame.event.type === 'turn/end') break;}}
    assert.match(JSON.stringify(log), /approval\/decided/);
    assert.match(JSON.stringify(log), /allowed-once/);
    assert.match(JSON.stringify(log.filter(event => event.type === 'tool/result')), /approved[^a-z]+true/);
  } finally {await follow?.close(); await events.close(); await runtime.dispose();}
});
