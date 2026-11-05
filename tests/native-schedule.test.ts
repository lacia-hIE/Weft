import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Response, type V4FetchHandler } from 'miniflare';
import type { SessionPage } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

/** The 0.2.2 schedule tool takes RFC 5545 timing: one UTC occurrence `delayMs` from now. */
function oneShotRule(delayMs: number): string {
  const at = new Date(Math.ceil((Date.now() + delayMs) / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `DTSTART:${at}\nRRULE:FREQ=DAILY;COUNT=1`;
}

/** Only model HTTP is scripted; the original schedule tool, service and DO alarm deliver the reminder. */
function scheduleModel() {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://schedule-model.test') throw new Error('Unexpected schedule fixture outbound request');
    const body = JSON.stringify(await request.json());
    const reminder = body.includes('REMINDER_ALPHA') && !body.includes('SCHEDULE_TASK');
    const tool = body.includes('SCHEDULE_TASK') && !body.includes('tool_result');
    const args = JSON.stringify({prompt: 'REMINDER_ALPHA', title: 'Alpha reminder', rrule: oneShotRule(2_000), target: 'this_session'});
    const text = reminder || body.includes('REMINDER_ALPHA') && body.lastIndexOf('REMINDER_ALPHA') > body.lastIndexOf('tool_result') ? 'REMINDED' : 'SCHEDULED';
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'schedule', name: 'schedule_create', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound};
}

test('the original schedule tool arms a Durable Object alarm that delivers its reminder after workerd restarts', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-schedule-'));
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'schedule-fixture', DEEPSEEK_BASE_URL: 'https://schedule-model.test/anthropic'}, outbound: scheduleModel().outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const page = async () => {
    const projections = await api.call<{asOfSeq: number}>('session/projections', {request: {sessionId: 'reminded'}});
    return (await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: 'reminded'}, throughSeq: projections.asOfSeq}})).records.map(record => record.event);
  };
  try {
    await api.call('session/create', {request: {sessionId: 'reminded'}});
    const follow = await api.follow('reminded');
    assert.equal((await follow.next()).type, 'snapshot');
    await api.call('session/prompt', {request: {sessionId: 'reminded', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'SCHEDULE_TASK'}]}});
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await follow.close();

    // 0.2.2 manages Host tasks by id; the environment aggregates the stores of its Sessions.
    const listed = await api.call<{items: {id: string; title: string}[]; total: number}>('schedule/list', {request: {active: true}});
    assert.deepEqual(listed.items.map(record => record.title), ['Alpha reminder']);
    const catalog = await api.call<{id: string; target: {kind: string; sessionId?: string}; status: string}[]>('schedule/catalog', {});
    assert.deepEqual(catalog.map(entry => [entry.id, entry.target.sessionId, entry.status]), [[listed.items[0]!.id, 'reminded', 'active']]);
    const viewed = await api.call<{id: string; title: string}>('schedule/view', {request: {id: listed.items[0]!.id}});
    assert.equal(viewed.title, 'Alpha reminder');
    assert.deepEqual(await api.call('schedule/view', {request: {id: 'schedule-missing'}}), {id: 'schedule-missing', code: 'schedule_not_found'});
    const refused = await api.raw('schedule/create', {request: {title: 'Fresh', prompt: 'NEW_SESSION', timing: {kind: 'rrule', rrule: oneShotRule(60_000)}}});
    assert.equal(refused.result.error?.code, 'schedule/input-invalid', 'a SessionDO creates no other Session');

    // Evict every object before the reminder is due; only the persisted alarm can wake the Session.
    await runtime.dispose();
    await delay(2_500);
    runtime = createRuntime(directory, options);
    let events: {type: string; data?: unknown}[] = [];
    for (const end = Date.now() + 30_000; Date.now() < end; await delay(250)) {
      events = await page();
      if (events.some(event => event.type === 'turn/end' && events.indexOf(event) > events.findIndex(item => item.type === 'user/message' && JSON.stringify(item.data).includes('"kind":"schedule"')) && events.some(item => item.type === 'user/message' && JSON.stringify(item.data).includes('"kind":"schedule"')))) break;
    }
    const delivered = events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes('"kind":"schedule"'));
    assert.ok(delivered, 'the alarm delivered the reminder as a schedule-sourced user message');
    assert.match(JSON.stringify(delivered), /REMINDER_ALPHA/);
    assert.equal((await api.call<{total: number}>('schedule/list', {request: {active: true}})).total, 0, 'a one-shot reminder ends after delivery');
    const ended = await api.call<{status: string; lastDelivery?: unknown}[]>('schedule/catalog', {});
    assert.equal(ended[0]?.status, 'ended');
    assert.ok(ended[0]?.lastDelivery, 'the delivery receipt is retained');
  } finally {
    await runtime.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});
