import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPrivateKey, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Response, type V4FetchHandler} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import type {SessionListValue} from '@deepseek-ai/dsh-api-session-controller/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';

/** The 0.2.2 schedule tool takes RFC 5545 timing: one UTC occurrence `delayMs` from now. */
function oneShotRule(delayMs: number): string {
  const at = new Date(Math.ceil((Date.now() + delayMs) / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `DTSTART:${at}\nRRULE:FREQ=DAILY;COUNT=1`;
}

const plugin = JSON.parse(readFileSync('plugins/im/package.json', 'utf8')) as {name: string; version: string};
const qqSecret = 'qq-app-secret-for-turn-fixture';
const qqKey = (() => {
  let seed = qqSecret; while (seed.length < 32) seed += seed;
  return createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed.slice(0, 32))]), format: 'der', type: 'pkcs8'});
})();

/** The model schedules a reminder on request, answers it when due, and answers Web questions distinctly. */
const model: V4FetchHandler = async request => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const body = JSON.stringify(await request.json());
  // The schedule tool's own result echoes the prompt; only the delivered reminder carries the framing.
  // RRULE tasks deliver through the 0.2.2 batch framing.
  const framing = Math.max(body.lastIndexOf('[SCHEDULE REMINDER]'), body.lastIndexOf('[SCHEDULE REMINDER BATCH]'));
  const web = body.lastIndexOf('WEB_QUESTION') > Math.max(framing, body.lastIndexOf('SCHEDULE_TASK'));
  const tool = !web && body.includes('SCHEDULE_TASK') && !body.includes('tool_result');
  const reminded = !web && framing >= 0;
  const text = web ? 'WEB_ANSWER' : reminded ? 'REMINDED' : 'SCHEDULED';
  const args = JSON.stringify({prompt: 'REMINDER_ALPHA', title: 'Alpha reminder', rrule: oneShotRule(2_000), target: 'this_session'});
  return new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'schedule', name: 'schedule_create', input: {}} : {type: 'text', text: ''}}) +
    event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text}}) +
    event('content_block_stop', {index: 0}) +
    event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}});
};

test('IM sends schedule results and opted-in Web turns to the bound chat through Session turn notifications', {timeout: 300000}, async () => {
  const sent: {path: string; content: string}[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'weft-im-routes-'));
  const options: Parameters<typeof createRuntime>[1] = {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'turn-fixture', DEEPSEEK_BASE_URL: 'https://turn-model.test/anthropic'},
    packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'turn-model.test') return model(request, mf);
      if (target.hostname === 'bots.qq.com') return Response.json({access_token: 'qq-token', expires_in: '7200'});
      if (target.hostname === 'api.sgroup.qq.com') {sent.push({path: target.pathname, content: (await request.json() as {content?: string}).content ?? ''}); return Response.json({id: 'sent'});}
      return new Response('not found', {status: 404});
    },
  };
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime), tenant = tenantId('alpha'), base = `/v1/tenants/${tenant}/environments/default`;
  const hook = (path: string, init?: RequestInit) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(plugin.name)}${path}`), init as never);
  const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
    for (const end = Date.now() + 60_000; Date.now() < end; await delay(250)) {const value = await read(); if (value !== undefined) return value;}
    throw new Error(`${label} did not happen: ${JSON.stringify(sent)}`);
  };
  const configure = async (patch: Record<string, unknown>) => {
    const ns = entryNamespace(plugin.name, 'im-qq');
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns);
    assert.ok(form, `${ns} has a native Settings form`);
    await api.call('settings/update', {ns, patch, expectedRevision: form.revision});
  };
  const qq = async (id: string, content: string) => {
    const body = JSON.stringify({op: 0, id: 'event-' + id, t: 'C2C_MESSAGE_CREATE', d: {id, content, timestamp: new Date().toISOString(), author: {user_openid: 'qq-user'}}});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await hook('/qq', {method: 'POST', headers: {'content-type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), qqKey).toString('hex')}, body});
    assert.equal(response.status, 200, await response.text());
    return response;
  };
  const webTurn = async (sessionId: string, text: string) => {
    const follow = await api.follow(sessionId);
    try {
      assert.equal((await follow.next()).type, 'snapshot');
      await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
  };
  try {
    const offered = (await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(bundle => bundle.name === plugin.name)!;
    await api.call('pluginManager/installBundle', {spec: offered.installTarget!.spec, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal(row.permissions.sessions, true, 'turn notifications ride the existing Session permission');
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: {...row.permissions, network: true, routes: true}})})).status, 200);
    await configure({enabled: true, managementKey: 'qq-management', appId: '1020', appSecret: qqSecret, allowedSenders: ['qq-user']});
    await waitFor(async () => (await hook('/qq', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 13, d: {plain_token: 't', event_ts: '1'}})})).status === 200 ? true : undefined, 'QQ route');

    // The chat's own turn schedules a reminder; the reminder turn is not started by the chat.
    await qq('qq-msg-1', 'SCHEDULE_TASK');
    await waitFor(() => sent.find(row => row.content === 'SCHEDULED'), 'reply to the chat turn');
    const reminder = await waitFor(() => sent.find(row => row.content === 'REMINDED'), 'schedule result sent to the bound chat');
    assert.equal(reminder.path, '/v2/users/qq-user/messages');

    // By default a Web turn stays on the Web.
    const sessionId = (await api.call<SessionListValue>('session/list', {_request: {}})).items[0]!.sessionId;
    await webTurn(sessionId, 'WEB_QUESTION one');
    await delay(3000);
    assert.equal(sent.filter(row => row.content.includes('WEB_ANSWER')).length, 0, 'Web turns are not mirrored unless enabled');

    // Full sync mirrors later Web turns to the private chat with their question; earlier ones are not replayed.
    await configure({sessionSync: 'all'});
    await waitFor(async () => (await hook('/qq/status', {headers: {authorization: 'Bearer qq-management'}})).status === 200 ? true : undefined, 'reloaded QQ channel');
    await delay(1000);
    await webTurn(sessionId, 'WEB_QUESTION two');
    const mirrored = await waitFor(() => sent.find(row => row.content.includes('WEB_ANSWER')), 'mirrored Web turn');
    assert.equal(mirrored.content, '（Web）WEB_QUESTION two\n\nWEB_ANSWER');
    await delay(3000);
    assert.equal(sent.filter(row => row.content.includes('WEB_ANSWER')).length, 1, 'each turn is mirrored once and the earlier Web turn is not replayed');
    assert.equal(sent.filter(row => row.content === 'REMINDED').length, 1, 'repeated notifications do not resend');

    // A task owns its notification destination independently of the chat's current Session.
    const task = await api.call<{id: string; updatedAt: string}>('schedule/create', {request: {title: 'Survives new', prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(120_000)}, target: {kind: 'session', sessionId}}});
    const freshTask = await api.call<{id: string; updatedAt: string}>('schedule/create', {request: {title: 'Retarget me', prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(180_000)}, target: {kind: 'session', sessionId}}});
    await qq('qq-new-session', '/new');
    await waitFor(() => sent.find(row => row.content === '已开始新会话。'), 'new chat Session');
    const newSession = (await api.call<SessionListValue>('session/list', {_request: {}})).items.find(row => row.sessionId !== sessionId)!.sessionId;
    await runtime.dispose(); runtime = createRuntime(directory, options);
    await qq('qq-list-tasks', '/automations');
    await waitFor(() => sent.find(row => row.content.includes(task.id)), 'old task remains bound after /new');
    await api.call('schedule/run', {request: {id: task.id}});
    await waitFor(() => sent.filter(row => row.content === 'REMINDED').length === 2 ? true : undefined, 'old execution Session still notifies the chat');
    await delay(1500);
    // The global editor can move execution across SessionDOs; the task route stays fixed.
    const before = await api.call<{updatedAt: string; lastDelivery: unknown}>('schedule/view', {request: {id: task.id}});
    const moved = await api.call<{id: string; target: {sessionId: string}; lastDelivery: unknown}>('schedule/edit', {request: {id: task.id, action: 'update', expectedUpdatedAt: before.updatedAt, patch: {target: {kind: 'session', sessionId: newSession}}}});
    assert.equal(moved.id, task.id);
    assert.equal(moved.target.sessionId, newSession);
    assert.deepEqual(moved.lastDelivery, before.lastDelivery, 'retargeting preserves the delivery receipt');
    assert.deepEqual(await api.call('schedule/run', {request: {id: task.id}}), {id: task.id, code: 'schedule_execution_pending'}, 'moving a task retains its delivery floor');
    await api.call('schedule/edit', {request: {id: freshTask.id, action: 'update', expectedUpdatedAt: freshTask.updatedAt, patch: {target: {kind: 'session', sessionId: newSession}}}});
    await api.call('schedule/run', {request: {id: freshTask.id}});
    await waitFor(() => sent.filter(row => row.content === 'REMINDED').length === 3 ? true : undefined, 'retargeted execution notifies the original chat');
    const silent = await api.call<{id: string}>('schedule/create', {request: {title: 'No IM', prompt: 'REMINDER_ALPHA', timing: {kind: 'rrule', rrule: oneShotRule(180_000)}, target: {kind: 'session', sessionId: newSession}}});
    await qq('qq-disable-task', `/notify ${silent.id} off`);
    await waitFor(() => sent.find(row => row.content.startsWith('已关闭该任务')), 'task notification disabled');
    await api.call('schedule/run', {request: {id: silent.id}});
    await delay(3000);
    assert.equal(sent.filter(row => row.content === 'REMINDED').length, 3, 'off disables this task without mirroring it through the current chat');

  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
