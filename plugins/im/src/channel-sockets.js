import {bytes} from './shared.js';

const base64 = bytes => {let text = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(text);};

/**
 * QQ JSON gateway held by the connection gateway: it answers heartbeats with
 * the tracked sequence and drops heartbeat ACKs; hello, dispatch and control
 * frames wake the plugin, which identifies or resumes the tracked session.
 */
export function qqConnection(token, receive) {
  return {
    async open() {
      const response = await fetch('https://api.sgroup.qq.com/gateway', {headers: {authorization: `QQBot ${await token()}`}});
      if (!response.ok) throw new Error('QQ gateway discovery failed');
      const gateway = await response.json();
      const url = new URL(gateway.url);
      if (url.protocol !== 'wss:' || !/(?:^|\.)sgroup\.qq\.com$/i.test(url.hostname)) throw new Error('Untrusted channel WebSocket');
      return {url: url.href, idleMs: 60_000, track: [{path: 's', as: 'seq'}, {path: 'd.session_id', as: 'sessionId'}], drop: [{path: 'op', equals: 11}]};
    },
    async closed(info, connection) {await connection.update({state: {online: false}});},
    async message(raw, connection, state) {
      const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      if (frame.op === 10) {
        const interval = Number(frame.d?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid QQ heartbeat');
        const every = Math.min(interval, 300_000);
        await connection.update({heartbeat: {everyMs: every, frame: {text: '{"op":1,"d":{{state.seq}}}'}}, idleMs: Math.min(every * 2, 900_000)});
        const accessToken = await token();
        await connection.send(JSON.stringify(state.sessionId ? {op: 6, d: {token: `QQBot ${accessToken}`, session_id: state.sessionId, seq: state.seq ?? null}}
          : {op: 2, d: {token: `QQBot ${accessToken}`, intents: 1 << 25, shard: [0, 1]}}));
      } else if (frame.op === 7) await connection.reconnect();
      else if (frame.op === 9) {await connection.update({state: {sessionId: null, seq: null}}); await connection.reconnect();}
      else if (frame.op === 0) {
        if (frame.t === 'READY' || frame.t === 'RESUMED') await connection.update({state: {online: true}});
        else await receive(frame);
      }
    },
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

/** The pong header bytes; pongs only confirm liveness, so the gateway drops them. */
const PONG = base64(field(5, join([field(1, bytes('type')), field(2, bytes('pong'))])));

/** Feishu protobuf gateway held by the connection gateway; event fragments are reassembled and ACKed here. */
export function feishuConnection(credentials, receive) {
  const fragments = new Map();
  return {
    async open() {
      const base = credentials.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
      const response = await fetch(base + '/callback/ws/endpoint', {method: 'POST', headers: {'content-type': 'application/json', locale: 'zh'}, body: JSON.stringify({AppID: credentials.appId, AppSecret: credentials.appSecret})});
      const result = await response.json();
      if (!response.ok || result.code !== 0 || !result.data?.URL) throw new Error('Feishu gateway discovery failed');
      const gateway = new URL(result.data.URL), service = Number(gateway.searchParams.get('service_id'));
      if (gateway.protocol !== 'wss:' || !/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(gateway.hostname)) throw new Error('Untrusted channel WebSocket');
      const interval = Math.min(300_000, Math.max(1000, Number(result.data.ClientConfig?.PingInterval || 30) * 1000));
      return {url: gateway.href, heartbeat: {everyMs: interval, frame: {base64: base64(encodeFeishuFrame({3: service, headers: [['type', 'ping']]}))}},
        idleMs: Math.min(900_000, Math.max(5000, interval * 3)), drop: [{bytesInclude: PONG}]};
    },
    async connected(connection) {await connection.update({state: {online: true}});},
    async closed(info, connection) {fragments.clear(); await connection.update({state: {online: false}});},
    async message(raw, connection) {
      let frame;
      // An undecodable frame is skipped rather than redelivered forever.
      try {frame = decodeFeishuFrame(raw);} catch {return;}
      const headers = Object.fromEntries(frame.headers);
      if (frame[4] === 0n || headers.type !== 'event') return;
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
      await connection.send(encodeFeishuFrame({...frame, headers: [...frame.headers, ['biz_rt', '0']], 8: bytes(JSON.stringify({code}))}));
    },
  };
}
