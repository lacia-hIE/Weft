import {bytes} from './shared.js';

const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const unbase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const clean = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
async function post(url, body, signal, form = false) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json'}, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'manual'});
  const result = await response.json();
  if (!response.ok && !(form && response.status === 400 && result.error)) throw new Error('Registration service rejected the request');
  return result;
}
export const qqQr = {
  async start(signal) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const result = await post('https://q.qq.com/lite/create_bind_task', {key: base64(key)}, signal);
    if (result.retcode !== 0 || !clean(result.data?.task_id)) throw new Error('Invalid QQ registration');
    return {taskId: result.data.task_id, key, interval: 2000, expiresAt: Date.now() + 300_000,
      url: `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(result.data.task_id)}&source=deepseek-harness&_wv=2`};
  },
  async poll(device, signal) {
    const result = await post('https://q.qq.com/lite/poll_bind_result', {task_id: device.taskId}, signal);
    if (result.retcode !== 0) throw new Error('QQ registration failed');
    if (result.data?.status === 3) return {state: 'expired', error: 'qrExpiredError'};
    if (result.data?.status !== 2) return {};
    const data = result.data, encrypted = unbase64(data.bot_encrypt_secret);
    const key = await crypto.subtle.importKey('raw', device.key, 'AES-GCM', false, ['decrypt']);
    const secret = await crypto.subtle.decrypt({name: 'AES-GCM', iv: encrypted.subarray(0, 12)}, key, encrypted.subarray(12));
    const appId = clean(String(data.bot_appid ?? '')), appSecret = clean(new TextDecoder().decode(secret)), owner = clean(data.user_openid);
    if (!appId || !appSecret || !owner) throw new Error('Incomplete QQ credentials');
    return {credentials: {appId, appSecret, owner}};
  },
};

const accounts = domain => domain === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';
const registration = (domain, body, signal) => post(accounts(domain) + '/oauth/v1/app/registration', body, signal, true);
const milliseconds = (value, fallback, limit) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(1000, Math.min(limit, Number(value) * 1000)) : fallback;
export const feishuQr = {
  async start(signal, domain = 'feishu') {
    const result = await registration(domain, {action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id'}, signal);
    if (!clean(result.device_code) || !clean(result.verification_uri_complete)) throw new Error('Invalid Feishu registration');
    const url = new URL(result.verification_uri_complete);
    if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname) || url.username || url.password) throw new Error('Untrusted Feishu registration URL');
    url.searchParams.set('from', 'sdk'); url.searchParams.set('tp', 'sdk'); url.searchParams.set('source', 'node-sdk/deepseek-harness'); url.searchParams.set('createOnly', 'true');
    url.searchParams.set('name', '{user} 的 Weft AI 助手');
    const addons = {preset: false, scopes: {tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message.group_at_msg.include_bot:readonly', 'im:message:send_as_bot', 'im:resource', 'cardkit:card:write']}, events: {items: {tenant: ['im.message.receive_v1']}}};
    const compressed = await new Response(new Blob([bytes(JSON.stringify(addons))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    url.searchParams.set('addons', base64(compressed).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
    return {deviceCode: result.device_code, domain, url: url.href, interval: milliseconds(result.interval, 5000, 30_000), expiresAt: Date.now() + milliseconds(result.expires_in, 600_000, 600_000)};
  },
  async poll(device, signal) {
    let result = await registration(device.domain, {action: 'poll', device_code: device.deviceCode}, signal);
    if (result.user_info?.tenant_brand === 'lark' && device.domain !== 'lark') {
      device.domain = 'lark'; result = await registration('lark', {action: 'poll', device_code: device.deviceCode}, signal);
    }
    if (result.error === 'authorization_pending') return {};
    if (result.error === 'slow_down') {device.interval = Math.min(30_000, device.interval + 5000); return {interval: device.interval};}
    if (result.error === 'expired_token') return {state: 'expired', error: 'qrExpiredError'};
    if (result.error === 'access_denied') return {state: 'cancelled', error: 'qrDenied'};
    const appId = clean(result.client_id), appSecret = clean(result.client_secret), owner = clean(result.user_info?.open_id);
    if (!appId || !appSecret || !owner) throw new Error('Incomplete Feishu credentials');
    return {credentials: {appId, appSecret, owner, domain: device.domain}};
  },
};
