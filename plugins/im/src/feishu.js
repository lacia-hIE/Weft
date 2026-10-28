import Schema from '@deepseek-ai/schemastery';
import {bytes, header, hex, json, readBody, sha256, tokenCache} from './shared.js';
import {botSettings, channelSettings, managementKey, registerModelCatalog} from './management.js';

import {connectionMode, qrAccount} from './qr-account.js';
import {feishuQr} from './qr-providers.js';
import {feishuConnection} from './channel-sockets.js';

const HOSTS = {feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com'};

/** Decrypt an `{encrypt}` event body: AES-256-CBC, key SHA-256(encrypt key), IV the first 16 bytes. */
async function decrypt(encrypted, encryptKey) {
  const data = Uint8Array.from(atob(encrypted), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', await sha256(encryptKey), 'AES-CBC', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({name: 'AES-CBC', iv: data.subarray(0, 16)}, key, data.subarray(16));
  return JSON.parse(new TextDecoder().decode(plain));
}
/** `X-Lark-Signature` is SHA-256 over timestamp, nonce, encrypt key and the raw body. */
async function signed(request, body, encryptKey) {
  const timestamp = header(request, 'x-lark-request-timestamp') ?? '', nonce = header(request, 'x-lark-request-nonce') ?? '';
  const prefix = bytes(timestamp + nonce + encryptKey), message = new Uint8Array(prefix.length + body.length);
  message.set(prefix); message.set(body, prefix.length);
  return hex(await sha256(message)) === header(request, 'x-lark-signature');
}

/**
 * Feishu / Lark bots over event subscription: the platform posts events to this
 * plugin's route and replies use the open platform message API.
 */
export const name = 'dsh-im-feishu';
export const inject = ['im', 'webServer', 'storageDomain', 'weftConnections'];
export const Config = Schema.object({
  ...botSettings(), managementKey: managementKey(), connectionMode: connectionMode(),
  enabled: Schema.boolean().default(false).description('Receive events at /feishu and reply through the open platform.'),
  domain: Schema.union(['feishu', 'lark']).default('feishu').description('feishu: open.feishu.cn; lark: open.larksuite.com.'),
  appId: Schema.string().default('').description('App ID of the self-built app.'),
  appSecret: Schema.string().role('secret').default('').description('App Secret.'),
  verificationToken: Schema.string().role('secret').default('').description('Verification Token from Events and Callbacks.'),
  encryptKey: Schema.string().role('secret').default('').description('Encrypt Key; when set, events are encrypted and signed.'),
  allowedSenders: Schema.array(Schema.string()).default([]).description('open_id values allowed to talk to the bot.'),
  groupResponseMode: Schema.union(['mention', 'all']).default('mention').description('Respond to mentions or all received group messages; all requires platform group-message permission.'),
  maxChars: Schema.natural().min(200).max(10000).default(4000),
});

export async function apply(ctx, config) {
  registerModelCatalog(ctx, 'feishu', config);
  const requestToken = async credentials => {
    if (!credentials?.appId || !credentials.appSecret) throw new Error('Feishu credentials are required');
    const base = HOSTS[credentials.domain] ?? HOSTS.feishu;
    const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {method: 'POST', headers: {'content-type': 'application/json; charset=utf-8'}, body: JSON.stringify({app_id: credentials.appId, app_secret: credentials.appSecret})});
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw new Error('Feishu token request failed');
    return {value: body.tenant_access_token, expiresAt: Date.now() + Number(body.expire ?? 7200) * 1000};
  };
  const token = tokenCache(() => requestToken(account.credentials()));
  const receive = async payload => {
    if (payload.header?.event_type !== 'im.message.receive_v1') return;
    const message = payload.event?.message, sender = payload.event?.sender;
    if (!message || sender?.sender_type === 'app' || message.message_type !== 'text') return;
    const group = message.chat_type !== 'p2p';
    // In groups the bot answers only when mentioned.
    if (group && config.groupResponseMode !== 'all' && !(message.mentions?.length)) return;
    let text = '';
    try {text = String(JSON.parse(message.content).text ?? '');} catch {return;}
    for (const mention of message.mentions ?? []) text = text.replaceAll(mention.key, '');
    const senderId = sender?.sender_id?.open_id ?? '';
    await ctx.im.receive({channel: 'feishu', conversation: message.chat_id, chatId: message.chat_id, sender: senderId, senderName: sender?.name, sentAt: Number(message.create_time) || undefined, group, text, messageId: message.message_id,
      target: {chatId: message.chat_id, messageId: message.message_id}});
  };
  const account = await qrAccount(ctx, 'feishu', config, {...feishuQr, validate: requestToken, changed: () => token.clear(),
    socket: credentials => feishuConnection(credentials, receive)});
  // A disabled channel still closes the gateway connection it may have left open.
  if (!config.enabled) {account.launch(); return;}
  const api = async (path, body) => {
    for (let retry = 0; ; retry++) {
      const response = await fetch(`${HOSTS[account.credentials()?.domain] ?? HOSTS.feishu}${path}`, {method: 'POST', headers: {'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${await token.get()}`}, body: JSON.stringify(body)});
      const value = await response.json().catch(() => ({}));
      // 99991663/99991661: the tenant token expired or is invalid.
      if ((value.code === 99991663 || value.code === 99991661) && retry === 0) {token.clear(); continue;}
      if (!response.ok || value.code !== 0) throw new Error(`Feishu API ${path} failed: ${value.msg ?? response.status}`);
      return value;
    }
  };
  ctx.effect(() => ctx.im.channel('feishu', {
    ...channelSettings(config, () => account.owner(), () => account.credentials()?.appId),
    maxChars: config.maxChars,
    async send(target, text) {
      const content = JSON.stringify({text});
      if (target.messageId) {
        try {await api(`/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}/reply`, {msg_type: 'text', content}); return;}
        catch { /* A deleted or expired message cannot be replied to; send to the chat instead. */ }
      }
      await api('/open-apis/im/v1/messages?receive_id_type=chat_id', {receive_id: target.chatId, msg_type: 'text', content});
    },
  }), 'dsh-im feishu channel');

  account.launch();
  if (config.connectionMode === 'qr') return;
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/feishu', handler: async (request, response) => {
    if (request.method !== 'POST') {json(response, 405, {error: 'method not allowed'}); return;}
    const raw = await readBody(request);
    let payload;
    try {payload = JSON.parse(new TextDecoder().decode(raw));} catch {json(response, 400, {error: 'invalid json'}); return;}
    if (typeof payload.encrypt === 'string') {
      if (!config.encryptKey) {json(response, 400, {error: 'encrypted event without an encrypt key'}); return;}
      payload = await decrypt(payload.encrypt, config.encryptKey);
    }
    if (payload.type === 'url_verification') {
      if (config.verificationToken && payload.token !== config.verificationToken) {json(response, 403, {error: 'invalid token'}); return;}
      json(response, 200, {challenge: payload.challenge});
      return;
    }
    if (config.encryptKey && !await signed(request, raw, config.encryptKey)) {json(response, 401, {error: 'invalid signature'}); return;}
    if (config.verificationToken && payload.header?.token !== config.verificationToken) {json(response, 403, {error: 'invalid token'}); return;}
    // Answer within the platform's 3 s window; the bridge records the message before replying.
    json(response, 200, {});
    await receive(payload);
  }}), 'dsh-im feishu route');
}
