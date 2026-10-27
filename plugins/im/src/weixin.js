import Schema from '@deepseek-ai/schemastery';
import {background, json, sleep} from './shared.js';
import {qrSvg} from './qr.js';

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
const page = (title, body, refresh) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const escape = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * WeChat bots over iLink: a QR login page protected by a login key, then a
 * background long poll of getupdates; replies carry each user's context token.
 */
export const name = 'dsh-im-weixin';
export const inject = ['im', 'webServer', 'storageDomain'];
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('Log in at /weixin/login and long-poll messages.'),
  loginKey: Schema.string().role('secret').default('').description('Required as ?key= on the login page; anyone with the page can bind a WeChat account.'),
  allowedSenders: Schema.array(Schema.string()).default([]).description('User ids allowed besides the account that scanned the login code.'),
  maxChars: Schema.natural().min(200).max(4000).default(1800),
});

export async function apply(ctx, config) {
  if (!config.enabled) return;
  const domain = await ctx.storageDomain.open(DOMAIN);
  ctx.effect(() => () => domain.close(), 'dsh-im weixin storage');
  const state = () => domain.global.get();
  const save = patch => domain.global.set({...state(), ...patch});
  let poller, login;

  const poll = () => {
    if (poller && !poller.signal.aborted) return;
    poller = background(ctx, 'dsh-im weixin updates', async signal => {
      for (let failures = 0; !signal.aborted && state().state === 'online';) {
        const current = state();
        try {
          const response = await call(current.baseUrl, 'ilink/bot/getupdates', {body: {get_updates_buf: current.cursor ?? ''}, token: current.token, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])});
          if (response.errcode === -14 || response.ret === -14) {await save({state: 'expired', error: '登录已失效，请重新扫码。'}); return;}
          if ((response.ret ?? 0) !== 0) throw new Error(`getupdates rejected: ${response.ret}`);
          for (const message of response.msgs ?? []) {
            // 2 is the bot's own message.
            if (message?.message_type === 2) continue;
            const sender = message?.from_user_id, id = message?.message_id ?? message?.client_id, text = textOf(message);
            if (!sender || id === undefined || !text) continue;
            await ctx.im.receive({channel: 'weixin', conversation: sender, sender, text, messageId: String(id), target: {to: sender, contextToken: message.context_token}});
          }
          if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) await save({cursor: response.get_updates_buf});
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          // A timed-out long poll is an empty batch.
          if (error?.name === 'TimeoutError') continue;
          console.warn(`dsh-im weixin: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(Math.min(60_000, 2000 * 2 ** failures++), signal);
        }
      }
    });
  };

  const beginLogin = async () => {
    login?.abort();
    const created = await call(BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', {body: {local_token_list: []}});
    if (!created?.qrcode || !created.qrcode_img_content) throw new Error('WeChat did not return a login code');
    const url = new URL(created.qrcode_img_content);
    if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) throw new Error('WeChat returned an untrusted login URL');
    await save({state: 'login', qrcode: created.qrcode, qrcodeUrl: url.toString(), error: undefined});
    login = background(ctx, 'dsh-im weixin login', async signal => {
      let base = BASE;
      while (!signal.aborted && state().state === 'login') {
        let status;
        try {status = await call(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(created.qrcode)}`, {method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])});}
        catch (error) {
          if (signal.aborted) return;
          if (error?.name === 'TimeoutError') continue;
          await save({state: 'idle', error: `扫码状态查询失败：${error instanceof Error ? error.message : String(error)}`});
          return;
        }
        if (status.status === 'confirmed') {
          await save({state: 'online', token: status.bot_token, baseUrl: apiBase(status.baseurl), botId: status.ilink_bot_id, owner: status.ilink_user_id, cursor: '', qrcode: undefined, qrcodeUrl: undefined});
          poll();
          return;
        }
        if (status.status === 'expired') {await save({state: 'idle', error: '二维码已过期，请刷新页面重新获取。'}); return;}
        if (status.status === 'scaned_but_redirect' && status.redirect_host) base = apiBase(status.redirect_host);
        await sleep(1000, signal);
      }
    });
  };

  ctx.effect(() => ctx.im.channel('weixin', {
    maxChars: config.maxChars,
    allows: sender => sender === state().owner || config.allowedSenders.includes(sender),
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
    if (!config.loginKey || query.get('key') !== config.loginKey) {json(response, 403, {error: 'login key required'}); return;}
    const html = (status, body) => {response.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); response.end(body);};
    const current = state();
    if (current.state === 'online' && query.get('reset') !== '1') {
      html(200, page('微信已连接', `<p>机器人账号：${escape(current.botId ?? '')}</p><p>扫码人：${escape(current.owner ?? '')}</p><p>如需更换账号，在地址后加 <code>&amp;reset=1</code>。</p>`));
      return;
    }
    try {if (current.state !== 'login' || query.get('reset') === '1') {poller?.abort(); await beginLogin();}}
    catch (error) {html(502, page('无法获取二维码', `<p>${escape(error instanceof Error ? error.message : String(error))}</p>`)); return;}
    const next = state();
    html(200, page('用微信扫码登录', `${qrSvg(next.qrcodeUrl)}<p>请用作为机器人的微信扫码并确认，页面会自动刷新。</p>${next.error ? `<p>${escape(next.error)}</p>` : ''}`, true));
  }}), 'dsh-im weixin route');

  if (state().state === 'online') poll();
}
