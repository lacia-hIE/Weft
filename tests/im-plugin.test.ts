import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Response, type V4FetchHandler} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {archiveFiles} from './helpers/package-fixture.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';

/** The repository's plugin as the public registry would serve it. */
function imPackage() {
  const root = 'plugins/im', files: Record<string, string> = {};
  for (const path of ['package.json', 'cordis.patch.yml', 'README.md', ...readdirSync(join(root, 'src')).map(file => 'src/' + file)]) files[path] = readFileSync(join(root, path), 'utf8');
  const manifest = JSON.parse(files['package.json']!) as {name: string; version: string};
  const bytes = archiveFiles(files);
  const tarball = `https://registry.npmjs.org/${manifest.name}/-/dsh-im-${manifest.version}.tgz`;
  return {...manifest, bytes, manifest: {...manifest, dist: {tarball, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')}}};
}

/** Every model request answers with plain text. */
const textModel: V4FetchHandler = async () => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}})
    + event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'IM_REPLY'}})
    + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}),
  {headers: {'content-type': 'text/event-stream'}});
};

const qqSecret = 'qq-app-secret-for-fixture';
const qqKey = (() => {
  let seed = qqSecret; while (seed.length < 32) seed += seed;
  const key = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed.slice(0, 32))]), format: 'der', type: 'pkcs8'});
  return {key, public: createPublicKey(key)};
})();

test('the IM bundle bridges Feishu, QQ and WeChat conversations to native Sessions through environment egress', {timeout: 300000}, async () => {
  const plugin = imPackage(), sent: {host: string; path: string; body: Record<string, unknown>; authorization: string | null}[] = [];
  let status = 0, updates = 0;
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'im-fixture', DEEPSEEK_BASE_URL: 'https://im-model.test/anthropic'},
    packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'im-model.test') return textModel(request, mf);
      if (target.hostname === 'registry.npmjs.org') return request.url === plugin.manifest.dist.tarball ? new Response(plugin.bytes) : Response.json(plugin.manifest);
      const text = request.method === 'GET' ? '' : await request.text();
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const record = () => sent.push({host: target.hostname, path: target.pathname + target.search, body, authorization: request.headers.get('authorization')});
      if (target.hostname === 'open.feishu.cn') {
        if (target.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({code: 0, tenant_access_token: 'feishu-token', expire: 7200});
        record(); return Response.json({code: 0, data: {}});
      }
      if (target.hostname === 'bots.qq.com') return Response.json({access_token: 'qq-token', expires_in: '7200'});
      if (target.hostname === 'api.sgroup.qq.com') {record(); return Response.json({id: 'sent'});}
      if (target.hostname === 'ilinkai.weixin.qq.com') {
        if (target.pathname === '/ilink/bot/get_bot_qrcode') return Response.json({qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/fixture?qrcode=qr-1&bot_type=3'});
        if (target.pathname === '/ilink/bot/get_qrcode_status') return Response.json(status++ === 0 ? {status: 'wait'} : {status: 'confirmed', bot_token: 'wx-token', baseurl: 'ilinkai.weixin.qq.com', ilink_bot_id: 'bot@im.bot', ilink_user_id: 'owner@im.wechat'});
        if (target.pathname === '/ilink/bot/getupdates') {
          record();
          if (updates++ === 0) return Response.json({ret: 0, get_updates_buf: 'cursor-1', msgs: [{message_id: 101, from_user_id: 'owner@im.wechat', message_type: 1, context_token: 'ctx-1', item_list: [{type: 1, text_item: {text: '你好'}}]}]});
          await delay(1000); return Response.json({ret: 0, get_updates_buf: 'cursor-1', msgs: []});
        }
        if (target.pathname === '/ilink/bot/sendmessage') {record(); return Response.json({ret: 0});}
      }
      return new Response('not found', {status: 404});
    },
  });
  const api = nativeClient(() => runtime), tenant = tenantId('alpha'), base = `/v1/tenants/${tenant}/environments/default`;
  const hook = (path: string, init?: RequestInit) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(plugin.name)}${path}`), init as never);
  let last = '';
  const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
    for (const end = Date.now() + 60_000; Date.now() < end; await delay(250)) {const value = await read(); if (value !== undefined && value !== false) return value as T;}
    const installations = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations
      .map(({name, enabled, approved, lastError, permissions}) => ({name, enabled, approved, lastError, permissions}));
    throw new Error(`${label} did not happen: ${JSON.stringify({last, sent, installations})}`);
  };
  const configure = async (id: string, patch: Record<string, unknown>) => {
    const ns = entryNamespace(plugin.name, id);
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns);
    assert.ok(form, `${ns} has a native Settings form`);
    await api.call('settings/update', {ns, patch, expectedRevision: form.revision});
  };
  try {
    await api.call('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal(row.hostScope, 'environment');
    assert.deepEqual(row.configs?.map(entry => entry.id).sort(), ['im-core', 'im-feishu', 'im-qq', 'im-weixin']);
    assert.equal(row.permissions.sessions && row.permissions.storage && row.permissions.routes, true, 'The bundle-provided im service is not a Host service');
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: {...row.permissions, network: true, routes: true}})})).status, 200);
    await configure('im-feishu', {enabled: true, appId: 'cli_fixture', appSecret: 'feishu-secret', verificationToken: 'feishu-verify', encryptKey: 'feishu-encrypt', allowedSenders: ['ou_allowed']});
    await configure('im-qq', {enabled: true, appId: '1020', appSecret: qqSecret, allowedSenders: ['qq-user']});
    await configure('im-weixin', {enabled: true, loginKey: 'login-key-fixture'});

    // Feishu: plain URL verification, then an encrypted and signed message event.
    const challenge = await waitFor(async () => {
      const response = await hook('/feishu', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'url_verification', challenge: 'feishu-challenge', token: 'feishu-verify'})});
      if (response.status !== 200) {last = `${response.status} ${await response.text()}`; return undefined;}
      return await response.json() as {challenge: string};
    }, 'Feishu route');
    assert.deepEqual(challenge, {challenge: 'feishu-challenge'});
    const feishu = async (messageId: string, openId: string, raw = false) => {
      const event = {schema: '2.0', header: {event_id: crypto.randomUUID(), event_type: 'im.message.receive_v1', token: 'feishu-verify', app_id: 'cli_fixture'},
        event: {sender: {sender_id: {open_id: openId}, sender_type: 'user'}, message: {message_id: messageId, chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({text: '请帮忙'})}}};
      const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update('feishu-encrypt').digest(), iv);
      const body = JSON.stringify({encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(event)), cipher.final()]).toString('base64')});
      const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'nonce-' + messageId;
      const signature = raw ? 'bad' : createHash('sha256').update(timestamp + nonce + 'feishu-encrypt' + body).digest('hex');
      return hook('/feishu', {method: 'POST', headers: {'content-type': 'application/json', 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature}, body});
    };
    assert.equal((await feishu('om_forged', 'ou_allowed', true)).status, 401, 'Unsigned Feishu events are refused');
    assert.equal((await feishu('om_1', 'ou_allowed')).status, 200);
    const feishuReply = await waitFor(() => sent.find(row => row.host === 'open.feishu.cn' && row.path === '/open-apis/im/v1/messages/om_1/reply'), 'Feishu reply');
    assert.deepEqual(JSON.parse(feishuReply.body.content as string), {text: 'IM_REPLY'});
    assert.equal(feishuReply.authorization, 'Bearer feishu-token');
    assert.equal((await feishu('om_1', 'ou_allowed')).status, 200, 'A redelivered event is acknowledged');
    await feishu('om_2', 'ou_stranger');
    const denied = await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/om_2/reply'), 'Feishu denial');
    assert.match(JSON.parse(denied.body.content as string).text as string, /ou_stranger/);

    // QQ: the callback validation is signed with the AppSecret seed; events must be signed by the platform.
    const plain = {op: 13, d: {plain_token: 'plain-token', event_ts: '1700000000'}};
    const validation = await (await hook('/qq', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(plain)})).json() as {plain_token: string; signature: string};
    assert.equal(validation.plain_token, 'plain-token');
    assert.ok(verify(null, Buffer.from('1700000000plain-token'), qqKey.public, Buffer.from(validation.signature, 'hex')));
    const qq = async (id: string, openid: string) => {
      const body = JSON.stringify({op: 0, id: 'event-' + id, t: 'C2C_MESSAGE_CREATE', d: {id, content: '你好', timestamp: new Date().toISOString(), author: {user_openid: openid}}});
      const timestamp = String(Math.floor(Date.now() / 1000));
      return hook('/qq', {method: 'POST', headers: {'content-type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), qqKey.key).toString('hex')}, body});
    };
    assert.equal((await hook('/qq', {method: 'POST', headers: {'content-type': 'application/json', 'x-signature-timestamp': '1', 'x-signature-ed25519': '00'.repeat(64)}, body: '{"op":0}'})).status, 401);
    const ack = await qq('qq-msg-1', 'qq-user');
    assert.deepEqual(await ack.json(), {op: 12, d: 0});
    const qqReply = await waitFor(() => sent.find(row => row.host === 'api.sgroup.qq.com'), 'QQ reply');
    assert.equal(qqReply.path, '/v2/users/qq-user/messages');
    assert.deepEqual(qqReply.body, {content: 'IM_REPLY', msg_type: 0, msg_id: 'qq-msg-1', msg_seq: 1});
    assert.equal(qqReply.authorization, 'QQBot qq-token');

    // WeChat: the login page needs its key, shows a QR code and the scan starts the long poll.
    assert.equal((await hook('/weixin/login')).status, 403);
    const login = await hook('/weixin/login?key=login-key-fixture');
    assert.equal(login.status, 200);
    assert.match(await login.text(), /<svg[^>]+viewBox/);
    const wxReply = await waitFor(() => sent.find(row => row.path === '/ilink/bot/sendmessage'), 'WeChat reply');
    const msg = wxReply.body.msg as {to_user_id: string; context_token: string; item_list: {text_item: {text: string}}[]};
    assert.equal(msg.to_user_id, 'owner@im.wechat');
    assert.equal(msg.context_token, 'ctx-1');
    assert.equal(msg.item_list[0]!.text_item.text, 'IM_REPLY');
    assert.equal(wxReply.authorization, 'Bearer wx-token');
    assert.ok(sent.filter(row => row.path === '/ilink/bot/getupdates').slice(1).every(row => row.body.get_updates_buf === 'cursor-1'), 'The long poll resumes from the stored cursor');
    const online = await (await hook('/weixin/login?key=login-key-fixture')).text();
    assert.match(online, /bot@im\.bot/);

    // One native Session per admitted conversation; the refused sender opened none.
    const sessions = await api.call<{items: {sessionId: string; title?: string}[]}>('session/list', {_request: {}});
    assert.equal(sessions.items.length, 3, JSON.stringify(sessions.items));
  } finally {await runtime.dispose();}
});
