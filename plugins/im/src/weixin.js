import Schema from '@deepseek-ai/schemastery';
import {background, header, json, sleep} from './shared.js';
import {qrSvg} from './qr.js';
import {botSettings, channelSettings, registerModelCatalog} from './management.js';

const BASE = 'https://ilinkai.weixin.qq.com/';
const PROTOCOL = '2.4.6';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const record = {parse: value => value};
const DOMAIN = {name: 'im_weixin', version: 1, tables: {}, global: {schema: record, initial: {state: 'idle'}}};

const isWeixinHost = host => /(?:^|\.)(?:weixin\.qq\.com|wechat\.com)$/i.test(host.replace(/\.$/, ''));
/** The API base a login names, accepted only on WeChat hosts. */
function apiBase(value) {
  const url = new URL(value && !String(value).includes('://') ? `https://${value}` : value || BASE);
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || url.port && url.port !== '443') throw new Error('Untrusted WeChat API base');
  return `${url.origin}${url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'}`;
}
function headers(token) {
  const uin = btoa(String(crypto.getRandomValues(new Uint32Array(1))[0]));
  return {'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION, 'content-type': 'application/json',
    ...(token ? {AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': uin, authorization: `Bearer ${token}`} : {})};
}
async function call(base, endpoint, {method = 'POST', body, token, signal} = {}) {
  const url = new URL(endpoint, base);
  if (!isWeixinHost(url.hostname)) throw new Error('Untrusted WeChat endpoint');
  const response = await fetch(url, {method, headers: headers(token), ...(body === undefined ? {} : {body: JSON.stringify({...body, base_info: {channel_version: PROTOCOL, bot_agent: 'Weft-dsh-im/0.1'}})}), signal});
  if (!response.ok) throw new Error(`WeChat ${endpoint.split('?')[0]} failed: HTTP ${response.status}`);
  return response.json();
}
const textOf = message => (message?.item_list ?? []).filter(item => item?.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
const page = (title, body, refresh) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const escape = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * WeChat bots over iLink: a QR login page protected by a login key, then a
 * background long poll of getupdates; replies carry each user's context token.
 */
export const name = 'dsh-im-weixin';
export const inject = ['im', 'webServer', 'storageDomain', 'weftConnections'];
export const Config = Schema.object({
  ...botSettings(),
  enabled: Schema.boolean().default(false).description('Log in at /weixin/login and long-poll messages.'),
  loginKey: Schema.string().role('secret').default('').description('Required as ?key= on the login page; anyone with the page can bind a WeChat account.'),
  allowedSenders: Schema.array(Schema.string()).default([]).description('User ids allowed besides the account that scanned the login code.'),
  maxChars: Schema.natural().min(200).max(4000).default(1800),
});

export async function apply(ctx, config) {
  registerModelCatalog(ctx, 'weixin', config);
  const domain = await ctx.storageDomain.open(DOMAIN);
  ctx.effect(() => () => domain.close(), 'dsh-im weixin storage');
  const state = () => domain.global.get();
  const save = patch => domain.global.set({...state(), ...patch});
  let connection, login, starting;
  // QR status polling cannot survive a plugin restart; do not serve an orphaned code.
  if (state().state === 'login') await save({state: 'idle', qrcode: undefined, qrcodeUrl: undefined});

  /** The long poll lives in the shared gateway; the cursor advances once a batch is handled here. */
  const poll = () => {
    const account = state();
    connection = ctx.weftConnections.poll('weixin', {
      version: `${account.botId}:${account.session ?? ''}`,
      open() {
        const current = state();
        if (current.state !== 'online') throw new Error('WeChat account is not logged in');
        return {request: {url: new URL('ilink/bot/getupdates', current.baseUrl).href, method: 'POST', headers: headers(current.token),
          body: `{"get_updates_buf":{{cursor}},"base_info":${JSON.stringify({channel_version: PROTOCOL, bot_agent: 'Weft-dsh-im/0.1'})}}`},
        cursor: {path: 'get_updates_buf', initial: current.cursor ?? ''}, deliverWhen: {path: 'msgs', nonEmpty: true},
        failWhen: [{path: 'ret', notIn: [0, null]}, {path: 'errcode', notIn: [0, null]}], timeoutMs: 45_000};
      },
      async response(body) {
        for (const message of body.msgs ?? []) {
          // 2 is the bot's own message.
          if (message?.message_type === 2) continue;
          const sender = message?.from_user_id, id = message?.message_id ?? message?.client_id, text = textOf(message);
          if (!sender || id === undefined || !text) continue;
          await ctx.im.receive({channel: 'weixin', conversation: sender, sender, text, messageId: String(id), target: {to: sender, contextToken: message.context_token}});
        }
        if (typeof body.get_updates_buf === 'string' && body.get_updates_buf) await save({cursor: body.get_updates_buf});
      },
      async failed(body, current) {
        if (body?.errcode === -14 || body?.ret === -14) {await save({state: 'expired', error: '登录已失效，请重新扫码。'}); await current.close(); return;}
        console.warn(`dsh-im weixin: getupdates rejected: ${body?.ret ?? body?.errcode}`);
        await current.reconnect();
      },
    });
  };
  const stopPolling = async () => {connection = undefined; await ctx.weftConnections.close('weixin').catch(() => {});};

  const createLogin = async () => {
    const created = await call(BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', {body: {local_token_list: []}});
    if (!created?.qrcode || !created.qrcode_img_content) throw new Error('WeChat did not return a login code');
    const url = new URL(created.qrcode_img_content);
    if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) throw new Error('WeChat returned an untrusted login URL');
    login?.abort();
    await stopPolling();
    await save({state: 'login', qrcode: created.qrcode, qrcodeUrl: url.toString(), error: undefined});
    login = background(ctx, 'dsh-im weixin login', async signal => {
      let base = BASE;
      while (!signal.aborted && state().state === 'login') {
        let status;
        try {status = await call(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(created.qrcode)}`, {method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])});}
        catch (error) {
          if (signal.aborted) return;
          if (error?.name === 'TimeoutError') continue;
          await save({state: 'idle', qrcode: undefined, qrcodeUrl: undefined, error: `扫码状态查询失败：${error instanceof Error ? error.message : String(error)}`});
          return;
        }
        if (signal.aborted) return;
        if (status.status === 'confirmed') {
          await save({state: 'online', token: status.bot_token, baseUrl: apiBase(status.baseurl), botId: status.ilink_bot_id, owner: status.ilink_user_id, session: crypto.randomUUID(), cursor: '', qrcode: undefined, qrcodeUrl: undefined});
          poll();
          return;
        }
        if (status.status === 'expired') {await save({state: 'idle', qrcode: undefined, qrcodeUrl: undefined, error: '二维码已过期，请重新获取。'}); return;}
        if (status.status === 'scaned_but_redirect' && status.redirect_host) base = apiBase(status.redirect_host);
        await sleep(1000, signal);
      }
    });
  };
  // Multiple browser requests share one QR creation rather than invalidating each other's code.
  const beginLogin = () => starting ??= createLogin().finally(() => {starting = undefined;});
  const authorized = request => !!config.loginKey && header(request, 'authorization') === `Bearer ${config.loginKey}`;
  const statusView = () => {
    const current = state();
    return {state: config.enabled ? current.state : 'disabled', botId: current.botId, owner: current.owner, error: current.error,
      ...(current.state === 'login' ? {qrcodeUrl: current.qrcodeUrl} : {})};
  };
  const reply = (response, code, value) => {
    response.setHeader('cache-control', 'no-store');
    json(response, code, value);
  };
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/weixin/status', handler: (request, response) => {
    if (!authorized(request)) {reply(response, 403, {error: 'login key required'}); return;}
    if (request.method !== 'GET') {reply(response, 405, {error: 'GET required'}); return;}
    reply(response, 200, statusView());
  }}), 'dsh-im weixin status route');

  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/weixin/disconnect', handler: async (request, response) => {
    if (!authorized(request)) {reply(response, 403, {error: 'login key required'}); return;}
    if (request.method !== 'POST') {reply(response, 405, {error: 'POST required'}); return;}
    login?.abort(); await stopPolling();
    if (starting) await starting.catch(() => {});
    login?.abort(); await stopPolling();
    await ctx.im.clear('weixin');
    await domain.global.set({state: 'idle'});
    reply(response, 200, {state: 'idle'});
  }}), 'dsh-im weixin disconnect route');
  // Only an enabled, logged-in account keeps a long poll in the gateway.
  if (!config.enabled || state().state !== 'online') await stopPolling();
  if (!config.enabled) return;

  ctx.effect(() => ctx.im.channel('weixin', {
    ...channelSettings(config, () => state().owner, () => state().botId),
    maxChars: config.maxChars,
    async send(target, text) {
      const current = state();
      if (current.state !== 'online') throw new Error('WeChat account is not logged in');
      const response = await call(current.baseUrl, 'ilink/bot/sendmessage', {token: current.token, body: {msg: {
        from_user_id: '', to_user_id: target.to, client_id: crypto.randomUUID(), message_type: 2, message_state: 2,
        item_list: [{type: 1, text_item: {text}}], ...(target.contextToken ? {context_token: target.contextToken} : {}),
      }}});
      if ((response?.ret ?? 0) !== 0 || response?.errcode) throw new Error(`WeChat sendmessage rejected: ${response.ret ?? response.errcode}`);
    },
  }), 'dsh-im weixin channel');

  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: '/weixin/login', handler: async (request, response) => {
    const query = new URL(request.url, 'https://plugin.invalid').searchParams;
    if (request.method === 'POST') {
      if (!authorized(request)) {reply(response, 403, {error: 'login key required'}); return;}
      try {
        if (!['online', 'login'].includes(state().state) || query.get('reset') === '1') await beginLogin();
        reply(response, 200, statusView());
      } catch (error) {reply(response, 502, {error: error instanceof Error ? error.message : String(error)});}
      return;
    }
    if (request.method !== 'GET') {reply(response, 405, {error: 'GET or POST required'}); return;}
    if (!config.loginKey || query.get('key') !== config.loginKey) {json(response, 403, {error: 'login key required'}); return;}
    const html = (status, body) => {response.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); response.end(body);};
    const current = state();
    if (current.state === 'online' && query.get('reset') !== '1') {
      html(200, page('微信已连接', `<p>机器人账号：${escape(current.botId ?? '')}</p><p>扫码人：${escape(current.owner ?? '')}</p><p>如需更换账号，在地址后加 <code>&amp;reset=1</code>。</p>`));
      return;
    }
    try {if (current.state !== 'login' || query.get('reset') === '1') await beginLogin();}
    catch (error) {html(502, page('无法获取二维码', `<p>${escape(error instanceof Error ? error.message : String(error))}</p>`)); return;}
    const next = state();
    html(200, page('用微信扫码登录', `${qrSvg(next.qrcodeUrl)}<p>请用作为机器人的微信扫码并确认，页面会自动刷新。</p>${next.error ? `<p>${escape(next.error)}</p>` : ''}`, true));
  }}), 'dsh-im weixin route');

  if (state().state === 'online') poll();
}
