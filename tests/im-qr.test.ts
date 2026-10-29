import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Response} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import type {SessionListValue} from '@deepseek-ai/dsh-api-session-controller/types';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {imQrFixture} from './helpers/im-qr.ts';

test('QQ and Feishu QR creation bind privately, survive reload, and deliver native Sessions over real outbound sockets', {timeout: 240_000}, async () => {
  const provider = imQrFixture();
  const runtime = createRuntime(undefined, {packages: true, outbound: provider.outbound, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api = nativeClient(() => runtime), plugin = JSON.parse(readFileSync('plugins/im/package.json', 'utf8')) as {name: string; version: string};
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  let stage = 'install';
  const hook = (channel: string, path: string, method = 'GET', key = channel + '-key') => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenantId('alpha')}/default/${encodeURIComponent(plugin.name)}/${channel}/${path}`), {method, headers: {authorization: 'Bearer ' + key}});
  const wait = async <T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> => {
    for (const end = Date.now() + 60_000; Date.now() < end; await delay(200)) {const value = await read(); if (value !== undefined && value !== false) return value;}
    throw new Error(`QR fixture operation did not complete: ${stage}; sockets=${JSON.stringify(Object.fromEntries(Object.entries(provider.sockets).map(([channel, values]) => [channel, values.length])))}; frames=${JSON.stringify(provider.frames.filter(item => item.channel === 'feishu').slice(-4).map(item => {const frame = item.frame as {headers: unknown; 4?: bigint; 8?: Uint8Array}; return {method: String(frame[4]), headers: frame.headers, payload: frame[8] ? new TextDecoder().decode(frame[8]) : ''};}))}; requests=${[...new Set(provider.requests.map(item => item.host + item.path))].join(',')}`);
  };
  const configure = async (channel: string, patch: Record<string, unknown>) => {
    const ns = entryNamespace(plugin.name, 'im-' + channel);
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns)!;
    await api.call('settings/update', {ns, patch, expectedRevision: form.revision});
  };
  const status = async (channel: string, key?: string) => {
    const response = await hook(channel, 'status', 'GET', key);
    assert.equal(response.status, 200);
    const body = await response.json() as {state: string; botId?: string; error?: string; owner?: string; qrcodeUrl?: string; attemptId?: string};
    assert.doesNotMatch(JSON.stringify(body), /qq-qr-secret|feishu-qr-secret|invalid-fixture|deviceCode|device_code|bot_encrypt_secret|client_secret/);
    return body;
  };
  try {
    await api.call('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: row.permissions})})).status, 200);
    for (const channel of ['feishu', 'qq'] as const) {
      stage = channel + ' configuration';
      await configure(channel, {connectionMode: 'qr', enabled: true, accountConfigured: true, managementKey: channel + '-key'});
      await wait(async () => (await hook(channel, 'status')).status === 200 ? true : undefined);
      assert.equal((await hook(channel, 'login', 'POST', 'wrong')).status, 403);
      assert.equal((await hook(channel, 'login')).status, 405);
      const started = await hook(channel, 'login', 'POST');
      assert.equal(started.status, 200, `${channel} QR start: ${await started.text()}`);
      const pending = await status(channel);
      assert.equal(pending.state, 'login');
      assert.ok(pending.qrcodeUrl);
      assert.doesNotMatch(pending.qrcodeUrl, /client_secret|appSecret/);
      if (channel === 'feishu') {
        const addons = new URL(pending.qrcodeUrl).searchParams.get('addons'); assert.ok(addons);
        assert.equal(new URL(pending.qrcodeUrl).searchParams.get('createOnly'), 'true');
      }
      provider.mode(channel, 'expire');
      stage = channel + ' expiry';
      await wait(async () => (await status(channel)).state === 'expired' ? true : undefined);
      assert.equal((await status(channel)).qrcodeUrl, undefined);
      if (channel === 'feishu') {
        provider.mode(channel, 'deny'); await hook(channel, 'login', 'POST');
        await wait(async () => (await status(channel)).state === 'cancelled' ? true : undefined);
      }
      provider.mode(channel, 'wait');
      await hook(channel, 'login', 'POST');
      assert.notEqual((await status(channel)).attemptId, pending.attemptId);
      await hook(channel, 'cancel', 'POST');
      provider.mode(channel, 'confirm');
      await delay(2200);
      assert.equal((await status(channel)).state, 'idle', 'cancelled attempts cannot bind later');
      await hook(channel, 'login', 'POST');
      stage = channel + ' connection';
      const account = await wait(async () => {const current = await status(channel); return current.state === 'online' ? current : undefined;});
      assert.ok(account.botId); assert.equal(account.owner, channel === 'qq' ? 'qq-qr-owner' : 'ou_qr_owner');
      assert.equal((await runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenantId('alpha')}/default/${encodeURIComponent(plugin.name)}/${channel}`), {method: 'POST', body: '{}'})).status, 404, 'QR bots receive messages without HTTP callbacks');
      const config = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(item => item.ns === entryNamespace(plugin.name, 'im-' + channel))!;
      assert.doesNotMatch(JSON.stringify(config), /qq-qr-secret|feishu-qr-secret/);
      assert.equal((config.value as {appId: string}).appId, '', 'QR credentials stay on the server rather than being returned to the browser form');
      if (channel === 'qq') provider.send('qq', {op: 0, s: 3, t: 'C2C_MESSAGE_CREATE', d: {id: 'qq-qr-msg', content: 'QQ QR native prompt', author: {user_openid: 'qq-qr-owner'}}});
      else provider.send('feishu', {header: {event_type: 'im.message.receive_v1'}, event: {sender: {sender_type: 'user', sender_id: {open_id: 'ou_qr_owner'}}, message: {message_id: 'feishu-qr-msg', chat_id: 'oc_qr_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({text: 'Feishu QR native prompt'})}}}, true);
      stage = channel + ' delivery';
      await wait(() => provider.sent.some(item => item.channel === channel) ? true : undefined);
      if (channel === 'feishu') {
        const sendGroup = (id: string, mentioned: string) => provider.send('feishu', {header: {event_type: 'im.message.receive_v1'}, event: {
          sender: {sender_type: 'user', sender_id: {open_id: 'ou_qr_owner'}},
          message: {message_id: id, chat_id: 'oc_qr_group', chat_type: 'group', message_type: 'text', mentions: [{key: '@_user_1', id: {open_id: mentioned}, name: 'Same display name'}], content: JSON.stringify({text: id})},
        }});
        sendGroup('qr-mention-human', 'ou_someone_else');
        sendGroup('qr-mention-self', 'ou_qr_bot');
        await wait(() => provider.sent.some(item => item.path === '/open-apis/im/v1/messages/qr-mention-self/reply') ? true : undefined);
        assert.equal(provider.sent.some(item => item.path === '/open-apis/im/v1/messages/qr-mention-human/reply'), false);
      }
      if (channel === 'qq') {
        const count = provider.sockets.qq.length;
        provider.sockets.qq.at(-1)!.close(1000, 'Reconnect fixture');
        await wait(async () => provider.sockets.qq.length > count && (await status('qq')).state === 'online' ? true : undefined);
        assert.ok(provider.frames.some(item => item.channel === 'qq' && (item.frame as {op: number}).op === 6), 'QQ resumes an established gateway session');
      }
      // The socket lives in the connection gateway: reloading the channel recovers stored credentials and keeps it.
      const before = provider.sockets[channel].length;
      await configure(channel, {managementKey: channel + '-rotated'});
      await wait(async () => {
        const response = await hook(channel, 'status', 'GET', channel + '-rotated');
        if (response.status !== 200) return undefined;
        const current = await response.json() as {state: string; botId: string};
        return current.state === 'online' && current.botId === account.botId ? true : undefined;
      });
      assert.equal(provider.sockets[channel].length, before, 'a plugin reload does not reopen the gateway connection');
      await configure(channel, {enabled: false});
      await wait(async () => (await status(channel, channel + '-rotated')).state === 'disabled' ? true : undefined);
      await configure(channel, {enabled: true});
      await wait(async () => (await status(channel, channel + '-rotated')).state === 'online' ? true : undefined);
      provider.mode(channel, 'invalid');
      await hook(channel, 'login', 'POST', channel + '-rotated');
      await wait(async () => (await status(channel, channel + '-rotated')).state === 'error' ? true : undefined);
      await hook(channel, 'cancel', 'POST', channel + '-rotated');
      assert.equal((await status(channel, channel + '-rotated')).botId, account.botId, 'failed replacement retains the existing account');
      await hook(channel, 'disconnect', 'POST', channel + '-rotated');
      assert.equal((await status(channel, channel + '-rotated')).state, 'idle');
    }
    const sessions = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(sessions.items.length, 3);
    assert.ok(provider.requests.some(item => item.host === 'accounts.larksuite.com'), 'Feishu authorization follows the Lark tenant switch');
    assert.ok(provider.requests.some(item => item.host === 'open.larksuite.com' && item.path.includes('/messages/')), 'Replies use the authorized tenant domain');
    const ack = provider.frames.find(item => item.channel === 'feishu' && (item.frame as {4?: bigint})[4] === 1n)?.frame as {1?: bigint; 2?: bigint; 8?: Uint8Array};
    assert.equal(ack[1], 9007199254740995n); assert.equal(ack[2], 9007199254740997n);
    assert.equal(JSON.parse(new TextDecoder().decode(ack[8])).code, 200);
  } finally {provider.close(); await runtime.dispose();}
});
