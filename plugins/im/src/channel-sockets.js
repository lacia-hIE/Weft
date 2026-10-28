import {bytes} from './shared.js';

/** An accepted outbound socket with serialized messages, bounded liveness and owned timers. */
async function socketSession(raw, allowed, signal, setup) {
  const url = new URL(raw);
  if (url.protocol !== 'wss:' || !allowed(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new Error('Untrusted channel WebSocket');
  url.protocol = 'https:';
  const response = await fetch(url, {headers: {upgrade: 'websocket'}, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: 'manual'});
  const socket = response.webSocket;
  if (!socket) throw new Error('Channel WebSocket upgrade failed');
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    let ended = false, chain = Promise.resolve(), heartbeat, watchdog;
    const finish = error => {
      if (ended) return;
      ended = true; clearInterval(heartbeat); clearTimeout(watchdog); signal.removeEventListener('abort', abort);
      try {socket.close(1000, 'Connection ended');} catch {}
      error ? reject(error) : resolve();
    };
    const abort = () => finish(signal.reason);
    const send = data => {if (!ended) socket.send(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);};
    const controls = {
      send,
      close: () => finish(new Error('Channel requested reconnect')),
      alive: (ms = 120_000) => {clearTimeout(watchdog); watchdog = setTimeout(() => finish(new Error('Channel heartbeat timed out')), ms);},
      heartbeat: (ms, run) => {clearInterval(heartbeat); heartbeat = setInterval(() => {try {run();} catch (error) {finish(error);}}, Math.max(1000, Math.min(300_000, ms)));},
    };
    const handler = setup(controls);
    socket.addEventListener('message', event => {
      chain = chain.then(() => {if (!ended) return handler.message(event.data);}).catch(finish);
    });
    socket.addEventListener('close', event => {handler.closed?.(event.code); finish();});
    socket.addEventListener('error', () => finish(new Error('Channel WebSocket failed')));
    signal.addEventListener('abort', abort, {once: true});
    socket.accept();
    if (signal.aborted) abort(); else {controls.alive(30_000); handler.open?.();}
  });
}

/** QQ JSON gateway: resume while the connection identity is valid. */
export function qqSocket(credentials, token, receive) {
  let session, sequence = null;
  return async (signal, online) => {
    const accessToken = await token();
    const response = await fetch('https://api.sgroup.qq.com/gateway', {headers: {authorization: `QQBot ${accessToken}`}, signal});
    if (!response.ok) throw new Error('QQ gateway discovery failed');
    const gateway = await response.json();
    let heartbeatMs = 45_000;
    await socketSession(gateway.url, host => /(?:^|\.)sgroup\.qq\.com$/i.test(host), signal, control => ({
      closed(code) {if ([4004, 4006, 4007, 4009].includes(code)) {session = undefined; sequence = null;}},
      async message(raw) {
        const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (frame.s != null) sequence = frame.s;
        const send = value => control.send(JSON.stringify(value));
        if (frame.op === 10) {
          const interval = Number(frame.d?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid QQ heartbeat');
          heartbeatMs = Math.min(interval, 300_000); control.alive(heartbeatMs * 2);
          control.heartbeat(interval, () => send({op: 1, d: sequence}));
          send(session ? {op: 6, d: {token: `QQBot ${accessToken}`, session_id: session, seq: sequence}}
            : {op: 2, d: {token: `QQBot ${accessToken}`, intents: 1 << 25, shard: [0, 1]}});
        } else if (frame.op === 11) control.alive(heartbeatMs * 2);
        else if (frame.op === 7) control.close();
        else if (frame.op === 9) {session = undefined; sequence = null; control.close();}
        else if (frame.op === 0) {
          if (frame.t === 'READY') {session = frame.d?.session_id; online();}
          else if (frame.t === 'RESUMED') online();
          else await receive(frame);
        }
      },
    }));
  };
}

// Feishu pbbp2 wire fields. Keep uint64 identifiers as BigInt through ACK encoding.
const join = parts => {const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) {output.set(part, offset); offset += part.length;} return output;};
const integer = value => {let n = BigInt(value), result = []; do {result.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n;} while (n); return new Uint8Array(result);};
const field = (id, value) => typeof value === 'bigint' || typeof value === 'number' ? join([integer(id * 8), integer(value)]) : join([integer(id * 8 + 2), integer(value.length), value]);
function fields(raw) {
  const data = new Uint8Array(raw), result = []; let offset = 0;
  const read = () => {let value = 0n; for (let shift = 0n; shift < 70n && offset < data.length; shift += 7n) {const byte = data[offset++]; value |= BigInt(byte & 127) << shift; if (!(byte & 128)) return value;} throw new Error('Invalid protobuf integer');};
  while (offset < data.length) {
    const tag = Number(read()), wire = tag & 7, id = tag >>> 3;
    if (wire === 0) result.push([id, read()]);
    else if (wire === 2) {const length = Number(read()); if (!Number.isSafeInteger(length) || offset + length > data.length) throw new Error('Invalid protobuf length'); result.push([id, data.slice(offset, offset + length)]); offset += length;}
    else if (wire === 1 || wire === 5) {offset += wire === 1 ? 8 : 4; if (offset > data.length) throw new Error('Invalid protobuf field');}
    else throw new Error('Unsupported protobuf field');
  }
  return result;
}
export function decodeFeishuFrame(raw) {
  if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) throw new Error('Feishu gateway requires binary frames');
  const frame = {headers: []};
  for (const [id, value] of fields(raw)) {
    if (id === 5) {const pair = Object.fromEntries(fields(value)); frame.headers.push([new TextDecoder().decode(pair[1]), new TextDecoder().decode(pair[2])]);}
    else frame[id] = value;
  }
  if ([1, 2, 3, 4].some(id => typeof frame[id] !== 'bigint')) throw new Error('Incomplete Feishu frame');
  return frame;
}
export function encodeFeishuFrame(frame) {
  return join([...[1, 2, 3, 4].map(id => field(id, frame[id] ?? 0)), ...frame.headers.map(([key, value]) => field(5, join([field(1, bytes(key)), field(2, bytes(value))]))), ...[6, 7, 8, 9].filter(id => frame[id] !== undefined).map(id => field(id, frame[id]))]);
}

/** Feishu protobuf gateway with fragment reassembly and native event ACKs. */
export function feishuSocket(credentials, receive) {
  return async (signal, online) => {
    const base = credentials.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    const response = await fetch(base + '/callback/ws/endpoint', {method: 'POST', headers: {'content-type': 'application/json', locale: 'zh'}, body: JSON.stringify({AppID: credentials.appId, AppSecret: credentials.appSecret}), signal});
    const result = await response.json();
    if (!response.ok || result.code !== 0 || !result.data?.URL) throw new Error('Feishu gateway discovery failed');
    const gateway = new URL(result.data.URL), service = Number(gateway.searchParams.get('service_id'));
    let interval = Number(result.data.ClientConfig?.PingInterval || 30) * 1000;
    const fragments = new Map();
    await socketSession(gateway.href, host => /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(host), signal, control => {
      const heartbeat = () => control.heartbeat(interval, () => control.send(encodeFeishuFrame({3: service, headers: [['type', 'ping']]})));
      return {
        open() {control.alive(interval * 3); heartbeat(); online();},
        async message(raw) {
          const frame = decodeFeishuFrame(raw), headers = Object.fromEntries(frame.headers);
          control.alive(interval * 3);
          if (frame[4] === 0n) {
            if (headers.type === 'pong' && frame[8]?.length) {
              const config = JSON.parse(new TextDecoder().decode(frame[8]));
              if (Number(config.PingInterval) > 0) {interval = Number(config.PingInterval) * 1000; heartbeat();}
            }
            return;
          }
          if (headers.type !== 'event') return;
          let payload = frame[8];
          const total = Number(headers.sum || 1), index = Number(headers.seq || 0);
          if (!Number.isInteger(total) || total < 1 || total > 256 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error('Invalid Feishu fragment');
          if (total > 1) {
            for (const [id, value] of fragments) if (Date.now() - value.at > 60_000) fragments.delete(id);
            if (!headers.message_id || fragments.size >= 128 && !fragments.has(headers.message_id)) throw new Error('Too many Feishu fragments');
            const parts = fragments.get(headers.message_id) ?? {at: Date.now(), size: 0, values: new Array(total).fill(null)};
            if (parts.values.length !== total) throw new Error('Conflicting Feishu fragments');
            parts.size += payload.length - (parts.values[index]?.length ?? 0);
            if (parts.size > 1_048_576 || [...fragments.values()].reduce((size, value) => size + value.size, 0) > 8_388_608) throw new Error('Feishu fragments are too large');
            parts.values[index] = payload; fragments.set(headers.message_id, parts);
            if (parts.values.some(part => part === null)) return;
            payload = join(parts.values); fragments.delete(headers.message_id);
          }
          if (!payload || payload.length > 1_048_576) throw new Error('Feishu event is too large');
          let code = 200;
          try {await receive(JSON.parse(new TextDecoder().decode(payload)));} catch {code = 500;}
          control.send(encodeFeishuFrame({...frame, headers: [...frame.headers, ['biz_rt', '0']], 8: bytes(JSON.stringify({code}))}));
        },
      };
    });
  };
}
