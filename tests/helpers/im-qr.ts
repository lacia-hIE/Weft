import {createCipheriv, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Response, WebSocketPair, type V4FetchHandler} from 'miniflare';

type Channel = 'qq' | 'feishu';
type Mode = 'wait' | 'confirm' | 'expire' | 'deny' | 'invalid';
type Frame = {headers: [string, string][]; [key: number]: bigint | Uint8Array};
const codec = await import(pathToFileURL(resolve('plugins/im/src/channel-sockets.js')).href) as {encodeFeishuFrame(frame: object): Uint8Array<ArrayBuffer>; decodeFeishuFrame(raw: ArrayBuffer | Uint8Array): Frame};
export const encodeFeishuFrame = codec.encodeFeishuFrame;

/** Simulates only provider protocols; the installed bundle and native Sessions run unchanged. */
export function imQrFixture() {
  const modes: Record<Channel, Mode> = {qq: 'wait', feishu: 'wait'};
  const tasks = new Map<string, Buffer>();
  const sockets: Record<Channel, WebSocketPair[1][]> = {qq: [], feishu: []};
  const frames: {channel: Channel; frame: unknown}[] = [], sent: {channel: Channel; path: string; body: Record<string, unknown>}[] = [];
  const requests: {host: string; path: string; body: Record<string, unknown>}[] = [];
  let qqNumber = 0, feishuNumber = 0;
  const outgoing = (channel: Channel, body: object, fragmented = false) => {
    const socket = sockets[channel].at(-1);
    if (!socket) throw new Error('Missing fixture gateway');
    if (channel === 'qq') socket.send(JSON.stringify(body));
    else {
      const payload = new TextEncoder().encode(JSON.stringify(body)), id = crypto.randomUUID(), middle = Math.floor(payload.length / 2);
      for (const index of fragmented ? [1, 0] : [0]) socket.send(codec.encodeFeishuFrame({1: 9007199254740995n, 2: 9007199254740997n, 3: 2, 4: 1, headers: [['type', 'event'], ['message_id', id], ['sum', fragmented ? '2' : '1'], ['seq', String(index)]], 8: fragmented ? index ? payload.slice(middle) : payload.slice(0, middle) : payload}).buffer);
    }
  };
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const channel: Channel = url.hostname.endsWith('sgroup.qq.com') ? 'qq' : 'feishu';
      const pair = new WebSocketPair(), server = pair[1]; server.accept(); sockets[channel].push(server);
      server.addEventListener('message', event => {
        if (channel === 'qq') {
          const frame = JSON.parse(String(event.data)) as {op: number}; frames.push({channel, frame});
          if (frame.op === 2) server.send(JSON.stringify({op: 0, s: 1, t: 'READY', d: {session_id: 'qq-session'}}));
          if (frame.op === 6) server.send(JSON.stringify({op: 0, s: 2, t: 'RESUMED', d: {}}));
          if (frame.op === 1) server.send(JSON.stringify({op: 11}));
        } else {
          if (!(event.data instanceof ArrayBuffer) && !ArrayBuffer.isView(event.data)) throw new Error(`Expected a binary Feishu frame, got ${typeof event.data}: ${String(event.data).slice(0, 70)}`);
          const frame = codec.decodeFeishuFrame(event.data as ArrayBuffer); frames.push({channel, frame});
          if (Object.fromEntries(frame.headers).type === 'ping') server.send(codec.encodeFeishuFrame({3: 2, headers: [['type', 'pong']], 8: new TextEncoder().encode('{"PingInterval":2}')}).buffer);
        }
      });
      if (channel === 'qq') setTimeout(() => {try {server.send(JSON.stringify({op: 10, d: {heartbeat_interval: 2000}}));} catch {}}, 50);
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    const text = request.method === 'POST' ? await request.text() : '';
    const body = text ? request.headers.get('content-type')?.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text) as Record<string, unknown> : {};
    requests.push({host: url.hostname, path: url.pathname, body});
    if (url.hostname === 'q.qq.com') {
      if (url.pathname.endsWith('/create_bind_task')) {
        const task = 'qq-task-' + ++qqNumber; tasks.set(task, Buffer.from(String(body.key), 'base64'));
        return Response.json({retcode: 0, data: {task_id: task}});
      }
      const key = tasks.get(String(body.task_id));
      if (!key) return Response.json({retcode: 1});
      if (modes.qq === 'wait') return Response.json({retcode: 0, data: {status: 1}});
      if (modes.qq === 'expire') return Response.json({retcode: 0, data: {status: 3}});
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([nonce, cipher.update(modes.qq === 'invalid' ? 'invalid-fixture' : 'qq-qr-secret'), cipher.final(), cipher.getAuthTag()]).toString('base64');
      return Response.json({retcode: 0, data: {status: 2, bot_appid: '10' + String(body.task_id).split('-').at(-1), bot_encrypt_secret: encrypted, user_openid: 'qq-qr-owner'}});
    }
    if (url.hostname.startsWith('accounts.')) {
      if (body.action === 'begin') return Response.json({device_code: 'feishu-device-' + ++feishuNumber, verification_uri_complete: `https://${url.hostname}/oauth/confirm?user_code=qr-${feishuNumber}`, expires_in: 600, interval: 1});
      if (modes.feishu === 'wait') return Response.json({error: 'authorization_pending'}, {status: 400});
      if (modes.feishu === 'expire') return Response.json({error: 'expired_token'}, {status: 400});
      if (modes.feishu === 'deny') return Response.json({error: 'access_denied'}, {status: 400});
      return Response.json({client_id: 'cli_' + String(body.device_code).split('-').at(-1), client_secret: modes.feishu === 'invalid' ? 'invalid-fixture' : 'feishu-qr-secret', user_info: {open_id: 'ou_qr_owner', tenant_brand: 'lark'}});
    }
    if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json(body.app_secret === 'invalid-fixture' ? {code: 1, msg: 'secret echo: invalid-fixture'} : {code: 0, tenant_access_token: 'fixture-token', expire: 7200});
    if (url.hostname === 'bots.qq.com') return Response.json(body.clientSecret === 'invalid-fixture' ? {message: 'invalid-fixture'} : {access_token: 'qq-fixture-token', expires_in: '7200'});
    if (url.pathname === '/open-apis/bot/v3/info') return Response.json({code: 0, bot: {open_id: 'ou_qr_bot'}});
    if (url.pathname === '/gateway') return Response.json({url: 'wss://gateway.sgroup.qq.com/ws'});
    if (url.pathname === '/callback/ws/endpoint') return Response.json({code: 0, data: {URL: 'wss://msg.larksuite.com/ws?service_id=2', ClientConfig: {PingInterval: 2}}});
    if (url.pathname.startsWith('/open-apis/im/') || url.pathname.startsWith('/v2/')) {
      const channel = url.hostname.endsWith('qq.com') ? 'qq' : 'feishu'; sent.push({channel, path: url.pathname, body}); return Response.json({code: 0, data: {}, id: 'sent'});
    }
    return new Response('Not found', {status: 404});
  };
  return {outbound, requests, frames, sent, sockets, send: outgoing,
    mode(channel: Channel, mode: Mode) {modes[channel] = mode;},
    close() {for (const list of Object.values(sockets)) for (const socket of list) try {socket.close(1000, 'Fixture ended');} catch {}},
  };
}
