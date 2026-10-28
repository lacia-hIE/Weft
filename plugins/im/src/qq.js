import Schema from '@deepseek-ai/schemastery';
import {bytes, fromHex, header, hex, json, readBody, tokenCache} from './shared.js';
import {botSettings, channelSettings, managementKey, registerModelCatalog} from './management.js';

import {connectionMode, qrAccount} from './qr-account.js';
import {qqQr} from './qr-providers.js';
import {qqSocket} from './channel-sockets.js';

const API = 'https://api.sgroup.qq.com';
const TOKEN = 'https://bots.qq.com/app/getAppAccessToken';
// PKCS#8 prefix of a raw 32-byte Ed25519 seed.
const PKCS8_PREFIX = fromHex('302e020100300506032b657004220420');

/** QQ derives the bot's Ed25519 key from its secret, repeated to 32 bytes. */
async function keys(secret) {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX); der.set(bytes(seed.slice(0, 32)).subarray(0, 32), PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', der, {name: 'Ed25519'}, true, ['sign']);
  const {x} = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey('jwk', {kty: 'OKP', crv: 'Ed25519', x}, {name: 'Ed25519'}, false, ['verify']);
  return {privateKey, publicKey};
}
const concat = (...parts) => {const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) {result.set(part, offset); offset += part.length;} return result;};

/**
 * QQ official bots over the HTTP callback: Ed25519-signed events at /qq,
 * passive replies to C2C and group @ messages through the v2 message API.
 */
export const name = 'dsh-im-qq';
export const inject = ['im', 'webServer', 'storageDomain'];
export const Config = Schema.object({
  ...botSettings(), managementKey: managementKey(), connectionMode: connectionMode(),
  enabled: Schema.boolean().default(false).description('Receive callback events at /qq and reply through the QQ bot API.'),
  appId: Schema.string().default('').description('AppID of the bot.'),
  appSecret: Schema.string().role('secret').default('').description('AppSecret; it also signs and verifies callbacks.'),
  allowedSenders: Schema.array(Schema.string()).default([]).description('user_openid / member_openid values allowed to talk to the bot.'),
  maxChars: Schema.natural().min(200).max(5000).default(2000),
});

export async function apply(ctx, config) {
  registerModelCatalog(ctx, 'qq', config);
  const requestToken = async credentials => {
    if (!credentials?.appId || !credentials.appSecret) throw new Error('QQ credentials are required');
    const response = await fetch(TOKEN, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({appId: credentials.appId, clientSecret: credentials.appSecret})});
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw new Error('QQ token request failed');
    return {value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 7200) * 1000};
  };
  let gateway;
  const token = tokenCache(() => requestToken(account.credentials()));
  const receive = async payload => {
    if (payload.op !== 0) return;
    const event = payload.d ?? {};
    if (payload.t === 'C2C_MESSAGE_CREATE') {
      const openid = event.author?.user_openid;
      if (!openid || typeof event.content !== 'string') return;
      await ctx.im.receive({channel: 'qq', conversation: 'c2c:' + openid, sender: openid, text: event.content, messageId: event.id,
        target: {kind: 'c2c', id: openid, msgId: event.id}});
    } else if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
      const group = event.group_openid, member = event.author?.member_openid;
      if (!group || !member || typeof event.content !== 'string') return;
      await ctx.im.receive({channel: 'qq', conversation: 'group:' + group, sender: member, group: true, text: event.content.replace(/<@!?[^>]+>/g, '').trim(), messageId: event.id,
        target: {kind: 'group', id: group, msgId: event.id}});
    }
  };
  const account = await qrAccount(ctx, 'qq', config, {...qqQr, validate: requestToken, changed: () => {token.clear(); gateway = undefined;},
    connect: async (credentials, signal, online) => {
      try {await (gateway ??= qqSocket(credentials, () => token.get(), receive))(signal, online);}
      catch (error) {token.clear(); throw error;}
    }});
  if (!config.enabled) return;
  const sequences = new Map();
  const post = async (path, body) => {
    for (let retry = 0; ; retry++) {
      const response = await fetch(`${API}${path}`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `QQBot ${await token.get()}`}, body: JSON.stringify(body)});
      if (response.status === 401 && retry === 0) {token.clear(); continue;}
      if (!response.ok) throw new Error(`QQ API ${path} failed: ${response.status}`);
      return;
    }
  };
  ctx.effect(() => ctx.im.channel('qq', {
    ...channelSettings(config, () => account.owner(), () => account.credentials()?.appId),
    maxChars: config.maxChars,
    async send(target, text) {
      const path = target.kind === 'group' ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`;
      // Each part of one passive reply needs its own msg_seq for the same msg_id.
      const seq = (sequences.get(target.msgId) ?? 0) + 1;
      sequences.set(target.msgId, seq);
      if (sequences.size > 500) sequences.delete(sequences.keys().next().value);
      try {await post(path, {content: text, msg_type: 0, msg_id: target.msgId, msg_seq: seq});}
      // The passive window closed during a long turn: send an active message instead.
      catch {await post(path, {content: text, msg_type: 0});}
    },
  }), 'dsh-im qq channel');

  account.launch();
  if (config.connectionMode === 'qr') return;
  if (!config.appSecret) throw new Error('QQ AppSecret is required');
  const signing = keys(config.appSecret);
  void signing.catch(() => {});
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/qq', handler: async (request, response) => {
    if (request.method !== 'POST') {json(response, 405, {error: 'method not allowed'}); return;}
    const raw = await readBody(request);
    let payload;
    try {payload = JSON.parse(new TextDecoder().decode(raw));} catch {json(response, 400, {error: 'invalid json'}); return;}
    const {privateKey, publicKey} = await signing;
    if (payload.op === 13) {
      const {plain_token: plainToken, event_ts: eventTs} = payload.d ?? {};
      if (typeof plainToken !== 'string' || typeof eventTs !== 'string') {json(response, 400, {error: 'invalid validation'}); return;}
      const signature = await crypto.subtle.sign({name: 'Ed25519'}, privateKey, bytes(eventTs + plainToken));
      json(response, 200, {plain_token: plainToken, signature: hex(signature)});
      return;
    }
    const signature = fromHex(header(request, 'x-signature-ed25519') ?? ''), timestamp = header(request, 'x-signature-timestamp') ?? '';
    if (signature.length !== 64 || (signature[63] & 224) !== 0 || !await crypto.subtle.verify({name: 'Ed25519'}, publicKey, signature, concat(bytes(timestamp), raw))) {
      json(response, 401, {error: 'invalid signature'}); return;
    }
    json(response, 200, {op: 12, d: 0});
    await receive(payload);
  }}), 'dsh-im qq route');
}
