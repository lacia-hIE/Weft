import {DurableObject} from 'cloudflare:workers';
import {z} from 'zod';
import {destination} from '../../native-plugins/src/network.ts';
import {connect} from 'cloudflare:sockets';
import {MailTransport, mailSpec, mailIdentity, mailReply, type MailSpec} from './mail.ts';
const mailboxTransport = () => new MailTransport((address, options) => connect(address, {secureTransport: options?.secureTransport ?? 'on', allowHalfOpen: options?.allowHalfOpen ?? false}));

/**
 * Shared holder of plugins' outbound sockets and long polls, so the owning
 * environments can sleep between business messages. It runs Host code only:
 * declarative rules answer heartbeats and control frames, everything else is
 * buffered and handed to the environment in order. See
 * docs/architecture/connection-gateway.md.
 */

export interface GatewayScope {tenantId: string; environmentId: string}
export interface GatewayReceipt {name: string; digest: string; activationId: string}
export type GatewayFrame = {text: string} | {base64: string};
export type Tracked = Record<string, string | number | boolean | null>;
export type GatewayEvent = ({type: 'connected'} | {type: 'frame'; data: GatewayFrame} | {type: 'closed'; reason: string; code?: number}
  | {type: 'response'; body: unknown} | {type: 'failed'; body: unknown}) & {state: Tracked};
export type GatewayStatus = {state: 'connecting' | 'open' | 'waiting' | 'paused'; version: string; tracked: Tracked} | null;
/** The environment side the gateway calls back. */
export interface GatewayEnvironment {
  nativeConnectionDeliver(scope: GatewayScope, receipt: GatewayReceipt, connectionId: string, events: GatewayEvent[]): Promise<'ok' | 'unknown' | 'revoked'>;
  nativeConnectionLease(scope: GatewayScope, receipt: GatewayReceipt, connectionIds: string[]): Promise<string[]>;
}

const value = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const base64 = z.string().max(87_384).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const frame = z.union([z.object({text: z.string().max(65_536)}).strict(), z.object({base64}).strict()]);
const path = z.string().min(1).max(128).regex(/^[\w$-]+(?:\.[\w$-]+)*$/);
const name = z.string().regex(/^\w{1,64}$/);
const headers = z.record(z.string().min(1).max(64), z.string().max(4096)).refine(value => Object.keys(value).length <= 32).default({});
const heartbeat = z.object({everyMs: z.number().int().min(1000).max(300_000), frame}).strict();
const idleMs = z.number().int().min(5000).max(900_000);
const socketSpec = z.object({
  kind: z.literal('socket'), url: z.string().max(4096), headers, heartbeat: heartbeat.optional(),
  track: z.array(z.object({path, as: name}).strict()).max(8).default([]),
  drop: z.array(z.union([z.object({path, equals: value}).strict(), z.object({bytesInclude: base64}).strict()])).max(16).default([]),
  idleMs: idleMs.default(120_000),
}).strict();
const pollSpec = z.object({
  kind: z.literal('poll'),
  request: z.object({url: z.string().max(4096), method: z.enum(['GET', 'POST']).default('POST'), headers, body: z.string().max(65_536).optional()}).strict(),
  cursor: z.object({path, initial: z.string().max(65_536).optional()}).strict(),
  deliverWhen: z.object({path, nonEmpty: z.literal(true)}).strict().optional(),
  failWhen: z.array(z.object({path, notIn: z.array(value).max(16)}).strict()).max(4).default([]),
  timeoutMs: z.number().int().min(1000).max(120_000).default(45_000),
}).strict();
export const connectionSpec = z.union([socketSpec, pollSpec, mailSpec]);
export type ConnectionSpec = z.infer<typeof connectionSpec>;
export const connectionPatch = z.object({heartbeat: heartbeat.optional(), idleMs: idleMs.optional(), state: z.record(name, value).optional()}).strict();

const MAX_FRAME = 1_048_576, MAX_RESPONSE = 4_194_304, MAX_EVENTS = 1000, MAX_BUFFER = 16_777_216, BATCH = 32;
const ALARM_MS = 60_000, LEASE_MS = 600_000;
const backoff = (attempt: number, cap = 30_000) => Math.min(cap, 1000 * 2 ** Math.max(0, attempt - 1));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Row = {key: string; scope: string; receipt: string; connection_id: string; version: string; spec: string; state: string; cursor: string; status: string; attempts: number};
interface Live {generation: number; socket?: WebSocket | undefined; connecting?: boolean; heartbeat?: ReturnType<typeof setInterval>; idle?: ReturnType<typeof setTimeout>; poll?: AbortController | undefined; pumping?: Promise<void> | undefined; drained: (() => void)[]}

function at(source: unknown, dotted: string): unknown {
  let current = source;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function encode(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}
const decode = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
function includes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let index = 0; index < needle.length; index++) if (haystack[start + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}
/** `{{state.x}}` and `{{cursor}}` become JSON values; nothing else is evaluated. */
const render = (text: string, state: Tracked, cursor = '') =>
  text.replace(/\{\{(?:state\.(\w{1,64})|(cursor))\}\}/g, (_, key: string | undefined) => JSON.stringify(key === undefined ? cursor : state[key] ?? null));
const payload = (data: GatewayFrame, state: Tracked) => 'text' in data ? render(data.text, state) : decode(data.base64);

export abstract class ConnectionGateway<Env = unknown> extends DurableObject<Env> {
  protected abstract environment(scope: GatewayScope): GatewayEnvironment;
  protected abstract capacity(): number;
  private readonly live = new Map<string, Live>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS connections (key TEXT PRIMARY KEY, scope TEXT NOT NULL, receipt TEXT NOT NULL, connection_id TEXT NOT NULL,
      version TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, cursor TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL) STRICT`);
    sql.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, event TEXT NOT NULL, bytes INTEGER NOT NULL, not_before INTEGER NOT NULL) STRICT');
    sql.exec('CREATE INDEX IF NOT EXISTS events_key ON events (key, id)');
    sql.exec('CREATE TABLE IF NOT EXISTS mail_deliveries (key TEXT NOT NULL, id TEXT NOT NULL, result TEXT, PRIMARY KEY(key, id)) STRICT');
    // A deploy or eviction drops every socket; the alarm restores them from storage.
    void ctx.blockConcurrencyWhile(async () => {if (this.count() && await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 1000);});
  }

  /** Register or replace one connection. A new connection is refused when this shard is full. */
  async open(input: {key: string; scope: GatewayScope; receipt: GatewayReceipt; connectionId: string; version: string; spec: unknown}): Promise<{ok: true} | {full: true}> {
    const spec = connectionSpec.parse(input.spec);
    if (spec.kind !== 'mail') destination(spec.kind === 'socket' ? spec.url : spec.request.url);
    const existing = this.row(input.key);
    if (!existing && this.count() >= this.capacity()) return {full: true};
    this.stop(input.key);
    const oldSpec = existing && JSON.parse(existing.spec) as ConnectionSpec | undefined;
    const accountChanged = spec.kind === 'mail' && (oldSpec?.kind !== 'mail' || mailIdentity(oldSpec) !== mailIdentity(spec));
    if (accountChanged) this.ctx.storage.sql.exec('DELETE FROM events WHERE key=?', input.key);
    // A fresh specification answers any reconnect question still waiting in the buffer.
    this.ctx.storage.sql.exec("DELETE FROM events WHERE key=? AND json_extract(event, '$.type')='closed'", input.key);
    this.ctx.storage.sql.exec(`INSERT INTO connections (key, scope, receipt, connection_id, version, spec, state, cursor, status, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connecting', ?)
      ON CONFLICT(key) DO UPDATE SET scope=excluded.scope, receipt=excluded.receipt, version=excluded.version, spec=excluded.spec, cursor=excluded.cursor, status='connecting'`,
    input.key, JSON.stringify(input.scope), JSON.stringify(input.receipt), input.connectionId, input.version.slice(0, 256), JSON.stringify(spec),
    accountChanged ? '{}' : existing?.state ?? '{}', accountChanged ? '' : existing?.cursor || (spec.kind === 'poll' ? spec.cursor.initial ?? '' : ''), existing?.attempts ?? 0);
    if (accountChanged) this.ctx.storage.sql.exec("UPDATE connections SET state='{}' WHERE key=?", input.key);
    await this.ensureAlarm();
    this.start(input.key);
    return {ok: true};
  }
  status(key: string): GatewayStatus {
    const row = this.row(key);
    return row ? {state: row.status as NonNullable<GatewayStatus>['state'], version: row.version, tracked: JSON.parse(row.state) as Tracked} : null;
  }
  send(key: string, data: GatewayFrame): void {
    const parsed = frame.parse(data), socket = this.live.get(key)?.socket, row = this.row(key);
    if (!socket || !row) throw new Error('Connection is not open');
    socket.send(payload(parsed, JSON.parse(row.state) as Tracked));
  }
  update(key: string, raw: unknown): void {
    const patch = connectionPatch.parse(raw), row = this.row(key);
    if (!row) throw new Error('Unknown connection');
    const spec = JSON.parse(row.spec) as ConnectionSpec;
    if (spec.kind === 'socket') {if (patch.heartbeat) spec.heartbeat = patch.heartbeat; if (patch.idleMs) spec.idleMs = patch.idleMs;}
    const state = {...JSON.parse(row.state) as Tracked, ...patch.state};
    this.ctx.storage.sql.exec('UPDATE connections SET spec=?, state=? WHERE key=?', JSON.stringify(spec), JSON.stringify(state), key);
    if (this.live.get(key)?.socket) this.arm(key);
  }
  /** Drop the current socket or poll; after the backoff the plugin is asked for a fresh specification. */
  reconnect(key: string): void {
    const socket = this.live.get(key)?.socket;
    if (socket) {this.disconnected(key, socket, 'reconnect'); try {socket.close(1000, 'Reconnect');} catch { /* already closed */ }}
    else if (this.row(key)) {this.stop(key); this.liveOf(key); this.disconnected(key, undefined, 'reconnect');}
  }
  close(key: string): void {
    this.stop(key);
    this.ctx.storage.sql.exec('DELETE FROM events WHERE key=?', key);
    this.ctx.storage.sql.exec('DELETE FROM connections WHERE key=?', key);
    this.ctx.storage.sql.exec('DELETE FROM mail_deliveries WHERE key=?', key);
    for (const resolve of this.live.get(key)?.drained.splice(0) ?? []) resolve();
    this.live.delete(key);
  }

  /** IMAP/SMTP operations are limited to the mailbox held by this admitted connection. */
  async mailCall(key: string, operation: 'mailCheck' | 'mailReply' | 'mailAttachment', argument?: unknown): Promise<unknown> {
    const row = this.row(key), spec = row && JSON.parse(row.spec) as ConnectionSpec | undefined;
    if (spec?.kind !== 'mail') throw new Error('Mailbox connection is not open');
    const transport = mailboxTransport();
    try {
      if (operation === 'mailCheck') {await transport.check(spec); return {state: 'ready'};}
      if (operation === 'mailAttachment') return await transport.attachment(spec, argument);
      const input = mailReply.parse(argument);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mailIdentity(spec) + (input.deliveryId ?? JSON.stringify(input))));
      if (this.row(key)?.version !== row?.version) throw new Error('Mailbox connection changed');
      const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const old = this.ctx.storage.sql.exec<{result: string | null}>('SELECT result FROM mail_deliveries WHERE key=? AND id=?', key, id).toArray()[0];
      if (old?.result) return JSON.parse(old.result);
      if (old) throw new Error('Mail delivery is uncertain; confirm in the mailbox before retrying');
      // Reserve before SMTP DATA. An ambiguous disconnect must never send a second copy.
      this.ctx.storage.sql.exec('INSERT INTO mail_deliveries (key, id) VALUES (?, ?)', key, id);
      const result = await transport.reply(spec, input);
      this.ctx.storage.sql.exec('UPDATE mail_deliveries SET result=? WHERE key=? AND id=?', JSON.stringify(result), key, id);
      return result;
    } catch {throw new Error('Mailbox operation failed; check credentials, TLS and server access');}
  }

  override async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<Row>('SELECT * FROM connections').toArray();
    if (!rows.length) return;
    for (const row of rows) {
      const live = this.liveOf(row.key);
      if ((row.status === 'connecting' || row.status === 'open') && !live.socket && !live.connecting && !live.poll) this.start(row.key);
      this.pump(row.key);
    }
    const lease = await this.ctx.storage.get<number>('lease') ?? 0;
    if (Date.now() >= lease) {
      await this.ctx.storage.put('lease', Date.now() + LEASE_MS);
      const groups = new Map<string, Row[]>();
      for (const row of rows) groups.set(row.scope + '\n' + row.receipt, [...groups.get(row.scope + '\n' + row.receipt) ?? [], row]);
      await Promise.allSettled([...groups.values()].map(async group => {
        const scope = JSON.parse(group[0]!.scope) as GatewayScope, receipt = JSON.parse(group[0]!.receipt) as GatewayReceipt;
        const valid = new Set(await this.environment(scope).nativeConnectionLease(scope, receipt, group.map(row => row.connection_id)));
        for (const row of group) if (!valid.has(row.connection_id)) this.close(row.key);
      }));
    }
    if (this.count()) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  private count(): number {return this.ctx.storage.sql.exec<{count: number}>('SELECT count(*) AS count FROM connections').one().count;}
  private row(key: string): Row | undefined {return this.ctx.storage.sql.exec<Row>('SELECT * FROM connections WHERE key=?', key).toArray()[0];}
  private liveOf(key: string): Live {
    let live = this.live.get(key);
    if (!live) this.live.set(key, live = {generation: 0, drained: []});
    return live;
  }
  private setStatus(key: string, status: string, attempts?: number): void {
    if (attempts === undefined) this.ctx.storage.sql.exec('UPDATE connections SET status=? WHERE key=?', status, key);
    else this.ctx.storage.sql.exec('UPDATE connections SET status=?, attempts=? WHERE key=?', status, attempts, key);
  }
  private async ensureAlarm(): Promise<void> {if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);}

  private start(key: string): void {
    const row = this.row(key);
    if (!row) return;
    if ((JSON.parse(row.spec) as ConnectionSpec).kind === 'socket') void this.openSocket(key);
    else {this.setStatus(key, 'open'); if ((JSON.parse(row.spec) as ConnectionSpec).kind === 'mail') void this.pollMail(key); else void this.poll(key);}
  }
  private async pollMail(key: string): Promise<void> {
    const live = this.liveOf(key); if (live.poll) return;
    const abort = live.poll = new AbortController(), row = this.row(key);
    if (!row) {live.poll = undefined; return;}
    try {
      const result = await mailboxTransport().poll(JSON.parse(row.spec) as MailSpec, row.cursor);
      if (abort.signal.aborted || !this.row(key)) return;
      if (result.messages.length) {
        this.enqueue(key, {type: 'response', body: result});
        await new Promise<void>(resolve => {live.drained.push(resolve); abort.signal.addEventListener('abort', () => resolve(), {once: true});});
      }
      if (!abort.signal.aborted && this.row(key)) {
        const state = {...JSON.parse(this.row(key)!.state) as Tracked, checkedAt: Date.now(), error: null};
        this.ctx.storage.sql.exec('UPDATE connections SET cursor=?, state=? WHERE key=?', result.cursor, JSON.stringify(state), key);
      }
    } catch {
      if (!abort.signal.aborted && this.row(key)) this.ctx.storage.sql.exec('UPDATE connections SET state=? WHERE key=?', JSON.stringify({...JSON.parse(this.row(key)!.state), error: 'mail_connection_failed', checkedAt: Date.now()}), key);
    } finally {if (live.poll === abort) live.poll = undefined;}
  }
  /** Close the live transport without telling the plugin; used before replacing or removing a connection. */
  private stop(key: string): void {
    const live = this.live.get(key);
    if (!live) return;
    live.generation++;
    clearInterval(live.heartbeat); clearTimeout(live.idle); live.poll?.abort();
    const socket = live.socket; live.socket = undefined; live.poll = undefined;
    try {socket?.close(1000, 'Connection replaced');} catch { /* already closed */ }
  }

  private async openSocket(key: string): Promise<void> {
    const live = this.liveOf(key);
    if (live.socket || live.connecting) return;
    const generation = live.generation, row = this.row(key);
    if (!row) return;
    const spec = JSON.parse(row.spec) as z.infer<typeof socketSpec>;
    live.connecting = true;
    try {
      const response = await fetch(destination(spec.url), {headers: {...spec.headers, upgrade: 'websocket'}, redirect: 'manual', signal: AbortSignal.timeout(20_000)});
      const socket = response.webSocket;
      if (!socket) throw new Error(`WebSocket upgrade failed: ${response.status}`);
      // Binary frames would otherwise arrive as Blobs.
      socket.binaryType = 'arraybuffer';
      socket.accept();
      if (live.generation !== generation || !this.row(key)) {socket.close(1000, 'Connection replaced'); return;}
      live.socket = socket;
      socket.addEventListener('message', event => this.received(key, socket, event.data as string | ArrayBuffer));
      socket.addEventListener('close', event => this.disconnected(key, socket, 'closed', event.code));
      socket.addEventListener('error', () => this.disconnected(key, socket, 'error'));
      this.setStatus(key, 'open');
      this.arm(key);
      this.enqueue(key, {type: 'connected'});
    } catch {
      if (live.generation === generation && this.row(key)) this.disconnected(key, undefined, 'connect-failed');
    } finally {live.connecting = false;}
  }
  /** Heartbeat and idle timers follow the current specification. */
  private arm(key: string): void {
    const live = this.liveOf(key), socket = live.socket, row = this.row(key);
    if (!socket || !row) return;
    const spec = JSON.parse(row.spec) as z.infer<typeof socketSpec>;
    clearInterval(live.heartbeat); clearTimeout(live.idle);
    if (spec.heartbeat) {
      const beat = spec.heartbeat;
      live.heartbeat = setInterval(() => {
        const current = this.row(key);
        try {if (current) socket.send(payload(beat.frame, JSON.parse(current.state) as Tracked));} catch {this.disconnected(key, socket, 'heartbeat-failed');}
      }, beat.everyMs);
    }
    live.idle = setTimeout(() => {this.disconnected(key, socket, 'idle'); try {socket.close(4000, 'Idle');} catch { /* already closed */ }}, spec.idleMs);
  }
  private received(key: string, socket: WebSocket, data: string | ArrayBuffer): void {
    const live = this.live.get(key), row = this.row(key);
    if (!live || live.socket !== socket || !row) return;
    const spec = JSON.parse(row.spec) as z.infer<typeof socketSpec>;
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {this.disconnected(key, socket, 'idle'); try {socket.close(4000, 'Idle');} catch { /* already closed */ }}, spec.idleMs);
    const bytes = typeof data === 'string' ? undefined : new Uint8Array(data);
    if ((bytes ? bytes.length : (data as string).length) > MAX_FRAME) {this.disconnected(key, socket, 'too-large'); try {socket.close(1009, 'Frame too large');} catch { /* closed */ } return;}
    let parsed: unknown;
    if (typeof data === 'string' && /^\s*[{[]/.test(data)) try {parsed = JSON.parse(data);} catch { /* not JSON */ }
    const state = JSON.parse(row.state) as Tracked;
    let changed = false;
    for (const rule of spec.track) {
      const found = parsed === undefined ? undefined : at(parsed, rule.path);
      if (found !== undefined && found !== null && (typeof found !== 'object') && state[rule.as] !== found) {state[rule.as] = found as string | number | boolean; changed = true;}
    }
    if (changed) this.ctx.storage.sql.exec('UPDATE connections SET state=? WHERE key=?', JSON.stringify(state), key);
    if (row.attempts) this.ctx.storage.sql.exec('UPDATE connections SET attempts=0 WHERE key=?', key);
    const dropped = spec.drop.some(rule => 'path' in rule ? parsed !== undefined && at(parsed, rule.path) === rule.equals : !!bytes && includes(bytes, decode(rule.bytesInclude)));
    if (!dropped) this.enqueue(key, {type: 'frame', data: bytes ? {base64: encode(bytes)} : {text: data as string}});
  }
  /** The plugin decides whether and how to reconnect; repeated failures delay the question. */
  private disconnected(key: string, socket: WebSocket | undefined, reason: string, code?: number): void {
    const live = this.live.get(key), row = this.row(key);
    if (!live || !row || socket && live.socket !== socket) return;
    clearInterval(live.heartbeat); clearTimeout(live.idle);
    live.socket = undefined; live.generation++;
    const attempts = row.attempts + 1;
    this.setStatus(key, 'waiting', attempts);
    this.enqueue(key, {type: 'closed', reason, ...(code === undefined ? {} : {code})}, Date.now() + backoff(attempts) - 1000);
  }

  private async poll(key: string): Promise<void> {
    const live = this.liveOf(key);
    if (live.poll) return;
    const abort = live.poll = new AbortController();
    try {
      for (let failures = 0; !abort.signal.aborted;) {
        const row = this.row(key);
        if (!row || row.status !== 'open') return;
        const spec = JSON.parse(row.spec) as z.infer<typeof pollSpec>, state = JSON.parse(row.state) as Tracked;
        let body: unknown;
        try {
          const response = await fetch(destination(spec.request.url), {method: spec.request.method, headers: spec.request.headers,
            ...(spec.request.body === undefined ? {} : {body: render(spec.request.body, state, row.cursor)}), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(spec.timeoutMs)])});
          const text = await response.text();
          if (!response.ok || text.length > MAX_RESPONSE) throw new Error(`Poll failed: ${response.status}`);
          body = JSON.parse(text);
        } catch (error) {
          if (abort.signal.aborted) return;
          // A long poll that times out is an empty batch.
          if (!(error instanceof Error && error.name === 'TimeoutError')) await wait(backoff(++failures, 60_000));
          continue;
        }
        failures = 0;
        if (spec.failWhen.some(rule => !rule.notIn.includes((at(body, rule.path) ?? null) as never))) {
          this.setStatus(key, 'paused');
          this.enqueue(key, {type: 'failed', body});
          return;
        }
        const next = at(body, spec.cursor.path), wanted = spec.deliverWhen ? at(body, spec.deliverWhen.path) : true;
        if (Array.isArray(wanted) ? wanted.length : wanted) {
          this.enqueue(key, {type: 'response', body});
          // The cursor advances only once the plugin has handled the batch.
          await new Promise<void>(resolve => {live.drained.push(resolve); abort.signal.addEventListener('abort', () => resolve(), {once: true});});
          if (abort.signal.aborted || !this.row(key)) return;
        }
        if (typeof next === 'string' && next) this.ctx.storage.sql.exec('UPDATE connections SET cursor=? WHERE key=?', next, key);
      }
    } finally {if (live.poll === abort) live.poll = undefined;}
  }

  private enqueue(key: string, event: {type: string; [field: string]: unknown}, notBefore = 0): void {
    const row = this.row(key);
    if (!row) return;
    const text = JSON.stringify({...event, state: JSON.parse(row.state) as Tracked});
    const buffered = this.ctx.storage.sql.exec<{count: number; bytes: number | null}>('SELECT count(*) AS count, sum(bytes) AS bytes FROM events WHERE key=?', key).one();
    if (event.type !== 'closed' && (buffered.count >= MAX_EVENTS || (buffered.bytes ?? 0) + text.length > MAX_BUFFER)) {
      // The environment cannot keep up: stop reading and tell the plugin once it can listen.
      const socket = this.live.get(key)?.socket;
      this.stop(key); this.setStatus(key, 'waiting');
      if (socket || event.type === 'frame') this.enqueue(key, {type: 'closed', reason: 'backpressure'});
      return;
    }
    this.ctx.storage.sql.exec('INSERT INTO events (key, event, bytes, not_before) VALUES (?, ?, ?, ?)', key, text, text.length, notBefore);
    this.pump(key);
  }
  /** Hand buffered events to the environment in order; a refusal closes the connection. */
  private pump(key: string): void {
    const live = this.liveOf(key);
    if (live.pumping) return;
    live.pumping = (async () => {
      for (let failures = 0; ;) {
        const row = this.row(key);
        if (!row) return;
        const batch = this.ctx.storage.sql.exec<{id: number; event: string; not_before: number}>('SELECT id, event, not_before FROM events WHERE key=? ORDER BY id LIMIT ?', key, BATCH).toArray();
        if (!batch.length) {for (const resolve of live.drained.splice(0)) resolve(); return;}
        const later = batch.findIndex(entry => entry.not_before > Date.now()), ready = later < 0 ? batch : batch.slice(0, later);
        if (!ready.length) {await wait(batch[0]!.not_before - Date.now()); continue;}
        const scope = JSON.parse(row.scope) as GatewayScope, receipt = JSON.parse(row.receipt) as GatewayReceipt;
        try {
          const result = await this.environment(scope).nativeConnectionDeliver(scope, receipt, row.connection_id, ready.map(entry => JSON.parse(entry.event) as GatewayEvent));
          if (result !== 'ok') {this.close(key); return;}
          this.ctx.storage.sql.exec('DELETE FROM events WHERE key=? AND id<=?', key, ready.at(-1)!.id);
          failures = 0;
        } catch {await wait(backoff(++failures));}
      }
    })().finally(() => {
      live.pumping = undefined;
      // An event enqueued while the loop was finishing must not wait for the next alarm.
      if (this.row(key) && this.ctx.storage.sql.exec<{count: number}>('SELECT count(*) AS count FROM events WHERE key=?', key).one().count) this.pump(key);
    });
  }
}
