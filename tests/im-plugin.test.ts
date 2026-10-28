import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Response, type V4FetchHandler} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import type {ModelCatalog, SessionListValue, SessionPage} from '@deepseek-ai/dsh-api-session-controller/types';
import type {SessionTitleEventData} from '@deepseek-ai/dsh-session-title';
import type {SessionEventMap} from '@deepseek-ai/dsh-session';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';

/** The repository plugin this deployment ships; the build packs it from plugins/im. */
const plugin = JSON.parse(readFileSync('plugins/im/package.json', 'utf8')) as {name: string; version: string};

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

test('the deployment-bundled IM plugin bridges Feishu, QQ and WeChat conversations to native Sessions through environment egress', {timeout: 300000}, async () => {
  let registry = 0;
  const sent: {host: string; path: string; body: Record<string, unknown>; authorization: string | null}[] = [];
  let status = 0, updates = 0;
  let loginMode: 'confirm' | 'wait' | 'expire' = 'confirm';
  let busyStarted = false, releaseBusy: (() => void) | undefined;
  const modelCalls: {model: string; output_config?: {effort: string}}[] = [];
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'im-fixture', DEEPSEEK_BASE_URL: 'https://im-model.test/anthropic'},
    packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'im-model.test') {
        modelCalls.push(await request.clone().json() as typeof modelCalls[number]);
        if (!busyStarted && (await request.clone().text()).includes('IM_SETTINGS_BUSY_TASK')) {
          busyStarted = true;
          await new Promise<void>(resolve => {releaseBusy = resolve;});
        }
        return textModel(request, mf);
      }
      if (target.hostname === 'registry.npmjs.org') {registry++; return new Response('not found', {status: 404});}
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
        if (target.pathname === '/ilink/bot/get_qrcode_status') return Response.json(loginMode === 'wait' ? {status: 'wait'} : loginMode === 'expire' ? {status: 'expired'} : status++ === 0 ? {status: 'wait'} : {status: 'confirmed', bot_token: 'wx-token', baseurl: 'ilinkai.weixin.qq.com', ilink_bot_id: 'bot@im.bot', ilink_user_id: 'owner@im.wechat'});
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
  const currentPage = async (sessionId: string) => {
    const stream = await api.follow(sessionId);
    try {
      const opening = await stream.next();
      assert.equal(opening.type, 'snapshot');
      if (opening.type !== 'snapshot') throw new Error('Expected Session snapshot');
      return opening;
    } finally {await stream.close();}
  };
  try {
    // The Plugins page offers the deployment's plugin before installation, without a registry.
    const offered = (await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(bundle => bundle.name === plugin.name)!;
    assert.equal(offered.installed, false);
    assert.equal(offered.availability, 'missing');
    assert.deepEqual(offered.installTarget, {spec: `${plugin.name}@${plugin.version}`, version: plugin.version});
    assert.deepEqual(offered.rows.map(row => row.rowId), ['im-core', 'im-feishu', 'im-weixin', 'im-qq']);
    const installed = await api.call<{application: string}>('pluginManager/installBundle', {spec: offered.installTarget!.spec, options: {requestId: crypto.randomUUID()}});
    assert.equal(installed.application, 'applied', JSON.stringify(installed));
    assert.equal(registry, 0, 'A bundled plugin never reaches the npm registry');
    assert.equal((await api.call<BundleInfo[]>('pluginManager/listBundles', {})).filter(bundle => bundle.name === plugin.name).length, 1, 'An installed bundled plugin is listed once');
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal(row.hostScope, 'environment');
    assert.deepEqual(row.configs?.map(entry => entry.id).sort(), ['im-core', 'im-feishu', 'im-qq', 'im-weixin']);
    assert.equal(row.permissions.sessions && row.permissions.storage && row.permissions.routes, true, 'The bundle-provided im service is not a Host service');
    assert.equal(row.permissions.client, true, 'The bundle includes the IM settings page');
    const approve = (permissions: Installation['permissions']) => runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions})});
    const current = async () => (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    // The review page's defaults grant neither network nor routes: channel entries park, the bundle stays enabled.
    assert.equal((await approve({...row.permissions, network: false, routes: false, credentials: false})).status, 200);
    await delay(3000);
    const parked = await current();
    assert.equal(parked.enabled, true, JSON.stringify(parked.lastError));
    assert.equal(parked.lastError, undefined);
    assert.equal((await hook('/feishu', {method: 'POST', body: '{}'})).status, 404, 'Routes stay closed until granted');
    assert.equal((await approve({...row.permissions, network: true, routes: true})).status, 200);
    await configure('im-feishu', {enabled: true, managementKey: 'feishu-management', appId: 'cli_fixture', appSecret: 'feishu-secret', verificationToken: 'feishu-verify', encryptKey: 'feishu-encrypt', allowedSenders: ['ou_allowed']});
    await configure('im-qq', {enabled: true, managementKey: 'qq-management', appId: '1020', appSecret: qqSecret, allowedSenders: ['qq-user']});
    await api.call('directoryPicker/createDirectory', {path: '/workspace', name: 'weixin-fixture'});
    await configure('im-weixin', {enabled: true, loginKey: 'login-key-fixture', workspace: '/workspace/weixin-fixture'});
    for (const [channel, key, botId] of [['feishu', 'feishu-management', 'cli_fixture'], ['qq', 'qq-management', '1020']] as const) {
      assert.equal((await hook(`/${channel}/status`)).status, 403);
      const checked = await hook(`/${channel}/status`, {headers: {authorization: `Bearer ${key}`}});
      assert.equal(checked.status, 200);
      const view = await checked.json() as {state: string; botId: string; checkedAt: number};
      assert.deepEqual(Object.keys(view).sort(), ['botId', 'checkedAt', 'state']);
      assert.equal(view.state, 'ready'); assert.equal(view.botId, botId);
      assert.ok(view.checkedAt > 0);
    }

    // Feishu: plain URL verification, then an encrypted and signed message event.
    const challenge = await waitFor(async () => {
      const response = await hook('/feishu', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'url_verification', challenge: 'feishu-challenge', token: 'feishu-verify'})});
      if (response.status !== 200) {last = `${response.status} ${await response.text()}`; return undefined;}
      return await response.json() as {challenge: string};
    }, 'Feishu route');
    assert.deepEqual(challenge, {challenge: 'feishu-challenge'});
    const feishu = async (messageId: string, openId: string, raw = false, messageText = '请帮忙', group = false) => {
      const event = {schema: '2.0', header: {event_id: crypto.randomUUID(), event_type: 'im.message.receive_v1', token: 'feishu-verify', app_id: 'cli_fixture'},
        event: {sender: {sender_id: {open_id: openId}, sender_type: 'user'}, message: {message_id: messageId, chat_id: group ? 'oc_group' : 'oc_chat', chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({text: messageText})}}};
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

    // WeChat: the settings page starts QR login through a header capability; status never returns a token.
    assert.equal((await hook('/weixin/status')).status, 403);
    assert.equal((await hook('/weixin/login', {method: 'POST'})).status, 403);
    const headers = {authorization: 'Bearer login-key-fixture'};
    const idle = await hook('/weixin/status', {headers});
    assert.equal(idle.headers.get('cache-control'), 'no-store');
    assert.equal((await idle.json() as {state: string}).state, 'idle');
    assert.equal((await hook('/weixin/status', {method: 'POST', headers})).status, 405);
    const started = await hook('/weixin/login', {method: 'POST', headers});
    assert.equal(started.status, 200);
    const qr = await started.json() as {state: string; qrcodeUrl: string};
    assert.equal(qr.state, 'login');
    assert.match(qr.qrcodeUrl, /^https:\/\/liteapp.weixin.qq.com\//);
    // The original keyed login page remains available.
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
    const publicState = await (await hook('/weixin/status', {headers})).json();
    assert.deepEqual(publicState, {state: 'online', botId: 'bot@im.bot', owner: 'owner@im.wechat'});
    assert.doesNotMatch(JSON.stringify(publicState), /wx-token|qrcode|cursor/);
    // Rotating a redacted login key reloads the channel while retaining the connected account.
    await configure('im-weixin', {loginKey: 'rotated-key'});
    const rotated = await waitFor(async () => {
      const response = await hook('/weixin/status', {headers: {authorization: 'Bearer rotated-key'}});
      return response.status === 200 ? await response.json() : undefined;
    }, 'rotated WeChat capability');
    assert.deepEqual(rotated, publicState);
    assert.equal((await hook('/weixin/status', {headers})).status, 403);
    const rotatedHeaders = {authorization: 'Bearer rotated-key'};
    await configure('im-weixin', {enabled: false});
    const paused = await waitFor(async () => {
      const response = await hook('/weixin/status', {headers: rotatedHeaders});
      const view = await response.json() as {state: string; owner?: string};
      return view.state === 'disabled' ? view : undefined;
    }, 'paused WeChat account');
    assert.equal(paused.owner, 'owner@im.wechat');
    assert.equal((await hook('/weixin/login', {method: 'POST', headers: rotatedHeaders})).status, 404);
    await configure('im-weixin', {enabled: true});
    await waitFor(async () => {
      const view = await (await hook('/weixin/status', {headers: rotatedHeaders})).json() as {state: string};
      return view.state === 'online' ? true : undefined;
    }, 'resumed WeChat account');

    // One native Session per admitted conversation; the refused sender opened none.
    const sessions = await api.call<SessionListValue>('session/list', {_request: {}});
    assert.equal(sessions.items.length, 3, JSON.stringify(sessions.items));
    const channelTitles = new Set<string>();
    let weixinWorkspace = false;
    for (const session of sessions.items) {
      const history = await api.follow(session.sessionId);
      try {
        const opening = await history.next();
        if (opening.type === 'snapshot' && opening.header.cwd === '/workspace/weixin-fixture') weixinWorkspace = true;
        if (opening.type === 'snapshot') {
          const title = opening.records.findLast(record => record.event.type === 'session/title')?.event;
          assert.ok(title && title.type === 'session/title', JSON.stringify(opening.records));
          const data = title.data as unknown as SessionTitleEventData;
          assert.notEqual(data.source.kind, 'user', 'IM must not pin sender ids through explicit rename');
          assert.ok(data.messageSeqs.length, 'Native title citations survive channel decoration');
          assert.doesNotMatch(data.title, /oc_chat|qq-user|owner@im/);
          channelTitles.add(data.title.split(' · ')[0]!);
        }
      } finally {await history.close();}
    }
    assert.equal(weixinWorkspace, true, 'WeChat created its native Session in the configured workspace');
    assert.deepEqual([...channelTitles].sort(), ['QQ', '微信', '飞书'].sort());
    // Explicit renames retain their user pin and do not stack channel prefixes.
    const renamed = await api.call<{title: string; seq: number}>('session/rename', {request: {sessionId: sessions.items[0]!.sessionId, title: '整理项目计划'}});
    assert.match(renamed.title, /^(微信|飞书|QQ) · 整理项目计划$/);
    const renamedPage = await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: sessions.items[0]!.sessionId}, throughSeq: renamed.seq}});
    const pinned = renamedPage.records.at(-1)!.event;
    assert.equal(pinned.type, 'session/title');
    assert.equal((pinned.data as unknown as SessionTitleEventData).source.kind, 'user');
    // Restarting during a scan clears the orphaned code, and expiry clears it too.
    loginMode = 'wait';
    assert.equal((await hook('/weixin/login?reset=1', {method: 'POST', headers: {authorization: 'Bearer rotated-key'}})).status, 200);
    await configure('im-weixin', {loginKey: 'after-restart'});
    const newHeaders = {authorization: 'Bearer after-restart'};
    const restarted = await waitFor(async () => {
      const response = await hook('/weixin/status', {headers: newHeaders});
      return response.status === 200 ? await response.json() as {state: string; qrcodeUrl?: string} : undefined;
    }, 'scan restart');
    assert.equal(restarted.state, 'idle');
    assert.equal(restarted.qrcodeUrl, undefined);
    assert.equal((await hook('/weixin/login', {method: 'POST', headers: newHeaders})).status, 200);
    loginMode = 'expire';
    const expired = await waitFor(async () => {
      const response = await hook('/weixin/status', {headers: newHeaders});
      const view = await response.json() as {state: string; error?: string; qrcodeUrl?: string};
      return view.state === 'idle' && view.error ? view : undefined;
    }, 'QR expiry');
    assert.equal(expired.qrcodeUrl, undefined);
    assert.match(expired.error!, /二维码已过期/);
    assert.equal((await hook('/weixin/disconnect', {method: 'POST'})).status, 403);
    assert.deepEqual(await (await hook('/weixin/disconnect', {method: 'POST', headers: newHeaders})).json(), {state: 'idle'});
    assert.deepEqual(await (await hook('/weixin/status', {headers: newHeaders})).json(), {state: 'idle'});
    // A removed account does not retain IM message deduplication or its old chat binding.
    loginMode = 'confirm'; updates = 0;
    assert.equal((await hook('/weixin/login', {method: 'POST', headers: newHeaders})).status, 200);
    await waitFor(async () => {
      const list = await api.call<{items: unknown[]}>('session/list', {_request: {}});
      return list.items.length === 4 ? true : undefined;
    }, 'fresh Session after removing the WeChat account');
    await configure('im-core', {titlePrefix: false});
    await feishu('om_new_unlabeled', 'ou_allowed', false, '/new');
    const unlabeled = await waitFor(async () => {
      const list = await api.call<SessionListValue>('session/list', {_request: {}});
      return list.items.find(item => item.blank);
    }, 'new Session with channel titles disabled');
    await feishu('om_unlabeled_prompt', 'ou_allowed');
    await waitFor(async () => {
      const list = await api.call<SessionListValue>('session/list', {_request: {}});
      const title = list.items.find(item => item.sessionId === unlabeled.sessionId)?.projections?.values.title;
      if (!title) return undefined;
      assert.doesNotMatch(title, /^(微信|飞书|QQ) · /);
      return true;
    }, 'native automatic title without a channel prefix');

    // Scene-specific access applies before commands and native Session admission.
    const policyScene = (mode: string, users: {id: string; canExecuteCommands: boolean}[] = []) => ({mode,
      open: {defaultCanExecuteCommands: false, commandPermissionOverrides: users}, allowlist: {users}});
    await configure('im-feishu', {managementKey: 'settings-regression', groupResponseMode: 'all', busyMessageMode: 'steer',
      accessPolicy: {direct: policyScene('open', [{id: 'ou_allowed', canExecuteCommands: true}]), group: policyScene('allowlist', [{id: 'ou_group', canExecuteCommands: false}])},
      contextEnhancement: {direct: {enabled: true, fields: ['channel', 'senderId'], guidance: 'Use only supplied fields.'}, group: {enabled: false, fields: ['senderId'], guidance: ''}}});
    await waitFor(async () => (await hook('/feishu/status', {headers: {authorization: 'Bearer settings-regression'}})).status === 200 ? true : undefined, 'updated settings activation');
    const beforeCommands = (await api.call<SessionListValue>('session/list', {_request: {}})).items.length;
    await feishu('settings-no-command', 'ou_stranger', false, '/new');
    const commandDenied = await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-no-command/reply'), 'private command denied');
    assert.match(commandDenied.body.content as string, /没有执行命令/);
    await feishu('settings-group-denied', 'ou_stranger', false, 'group access denied', true);
    const groupDenied = await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-group-denied/reply'), 'group sender denied');
    assert.match(groupDenied.body.content as string, /尚未授权/);
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items.length, beforeCommands);

    await feishu('settings-open-chat', 'ou_stranger', false, 'SCENE_OPEN_CHAT');
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-open-chat/reply'), 'open private conversation reply');
    const privatePage = await currentPage(unlabeled.sessionId);
    const privateUser = privatePage.records.findLast(record => record.event.type === 'user/message')!.event;
    const privateText = JSON.stringify(privateUser.data);
    assert.match(privateText, /dsh_im_source/);
    assert.match(privateText, /ou_stranger/);
    assert.match(privateText, /Use only supplied fields/);
    assert.doesNotMatch(privateText, /chatId|conversationType|botId|threadId/);
    await feishu('settings-group-chat', 'ou_group', false, 'SCENE_GROUP_CHAT', true);
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-group-chat/reply'), 'all-message group reply without mention');
    // Find the group prompt across new Sessions, without depending on generated titles.
    const newPages = await Promise.all((await api.call<SessionListValue>('session/list', {_request: {}})).items.filter(item => !sessions.items.some(old => old.sessionId === item.sessionId)).map(item => currentPage(item.sessionId)));
    const groupUser = newPages.flatMap(page => page.records).find(record => record.event.type === 'user/message' && JSON.stringify(record.event.data).includes('SCENE_GROUP_CHAT'));
    assert.ok(groupUser);
    assert.doesNotMatch(JSON.stringify(groupUser.event.data), /dsh_im_source|Use only supplied fields/);
    await feishu('settings-group-stop', 'ou_group', false, '/stop', true);
    const groupCommandDenied = await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-group-stop/reply'), 'group command permission denied');
    assert.match(groupCommandDenied.body.content as string, /没有执行命令/);
    await feishu('settings-manual-steer', 'ou_allowed', false, '/steer SCENE_STEER');
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-manual-steer/reply'), 'manual steer reply');
    await feishu('settings-busy-task', 'ou_allowed', false, 'IM_SETTINGS_BUSY_TASK');
    await waitFor(() => busyStarted ? true : undefined, 'model task running');
    await feishu('settings-auto-steer', 'ou_allowed', false, 'AUTO_STEER_TEXT');
    await feishu('settings-no-steer-permission', 'ou_stranger', false, 'QUEUED_WITHOUT_COMMAND_PERMISSION');
    await waitFor(async () => {
      const page = await currentPage(unlabeled.sessionId);
      const splices = page.records.filter(record => record.event.type === 'agent/inbox/spliced').map(record => ({data: record.event.data as unknown as SessionEventMap['agent/inbox/spliced']}));
      if (!splices.some(event => JSON.stringify(event.data.inserted).includes('QUEUED_WITHOUT_COMMAND_PERMISSION'))) return undefined;
      assert.equal(splices.find(event => JSON.stringify(event.data.inserted).includes('AUTO_STEER_TEXT'))?.data.target, 'next-step');
      assert.equal(splices.find(event => JSON.stringify(event.data.inserted).includes('QUEUED_WITHOUT_COMMAND_PERMISSION'))?.data.target, 'next-turn');
      return true;
    }, 'steering versus queue permission boundary');
    releaseBusy?.();
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-no-steer-permission/reply'), 'busy task reply');
    // Host catalog and bot model selection share native contracts, while the
    // bot's selection never becomes the environment default.
    assert.equal((await hook('/feishu/catalog')).status, 403);
    const catalogHeaders = {authorization: 'Bearer settings-regression'};
    assert.equal((await hook('/feishu/catalog', {method: 'POST', headers: catalogHeaders})).status, 405);
    const catalog = await (await hook('/feishu/catalog', {headers: catalogHeaders})).json() as ModelCatalog;
    const hostDefault = (await api.call<ModelCatalog>('session/modelCatalog', {})).default;
    assert.ok(catalog.groups.some(group => group.id === 'deepseek-official' && group.models.some(model => model.id === 'deepseek-flash')));
    await configure('im-feishu', {modelSelection: {provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low'}, managementKey: 'model-regression'});
    await waitFor(async () => (await hook('/feishu/catalog', {headers: {authorization: 'Bearer model-regression'}})).status === 200 ? true : undefined, 'model settings activation');
    assert.equal((await currentPage(unlabeled.sessionId)).records.filter(record => record.event.type === 'model/selection').length, 0, 'existing Sessions are not reconfigured');
    await feishu('settings-new-model-session', 'ou_allowed', false, '/new');
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-new-model-session/reply'), 'new Session with bot model');
    const selectedSession = (await api.call<SessionListValue>('session/list', {_request: {}})).items.find(item => item.blank);
    assert.ok(selectedSession);
    const selectedPage = await currentPage(selectedSession.sessionId);
    const selection = selectedPage.records.find(record => record.event.type === 'model/selection');
    assert.equal((selection?.event.data as {model: string}).model, 'deepseek-flash');
    assert.deepEqual((await api.call<ModelCatalog>('session/modelCatalog', {})).default, hostDefault);
    await feishu('settings-model-prompt', 'ou_allowed', false, 'Use my bot model selection');
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-model-prompt/reply'), 'selected model inference');
    assert.ok(modelCalls.some(call => call.model === 'deepseek-flash' && call.output_config?.effort === 'low'), 'the bot model and reasoning effort reach the inference request');
    assert.deepEqual((await api.call<ModelCatalog>('session/modelCatalog', {})).default, hostDefault);
    const beforeInvalid = (await api.call<SessionListValue>('session/list', {_request: {}})).items.length;
    await configure('im-feishu', {modelSelection: {provider: 'deepseek-official', model: 'not-in-catalog'}, managementKey: 'invalid-model-regression'});
    await waitFor(async () => (await hook('/feishu/catalog', {headers: {authorization: 'Bearer invalid-model-regression'}})).status === 200 ? true : undefined, 'invalid saved model activation');
    await feishu('settings-invalid-model', 'ou_allowed', false, '/new');
    const unavailable = await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-invalid-model/reply'), 'unavailable model explanation');
    assert.match(unavailable.body.content as string, /无法创建新会话/);
    assert.equal((await api.call<SessionListValue>('session/list', {_request: {}})).items.length, beforeInvalid, 'unavailable models do not create orphan Sessions');
    await feishu('settings-keep-old-model', 'ou_allowed', false, 'Keep using the existing Session');
    await waitFor(() => sent.find(row => row.path === '/open-apis/im/v1/messages/settings-keep-old-model/reply'), 'old route after rejected model');
  } finally {releaseBusy?.(); await runtime.dispose();}
});
