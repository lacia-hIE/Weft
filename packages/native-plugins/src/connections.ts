/**
 * The plugin face of `weftConnections`: sockets and long polls held by the
 * shared connection gateway (docs/architecture/connection-gateway.md).
 * Handlers are registered at activation and never persisted; the connection
 * itself outlives this facet, so disposal never closes it.
 */
type Frame = {text: string} | {base64: string};
type Tracked = Record<string, string | number | boolean | null>;
interface Event {type: 'connected' | 'frame' | 'closed' | 'response' | 'failed'; state: Tracked; data?: Frame; body?: unknown; reason?: string; code?: number}
interface Host {
  connectionOpen(connectionId: string, version: string, spec: unknown): Promise<void>;
  connectionCall(connectionId: string, operation: string, argument?: unknown): Promise<unknown>;
}
export interface Connection {
  readonly id: string;
  /** Settles once the gateway holds a connection for the current version. */
  readonly ready: Promise<void>;
  send(data: string | Uint8Array | ArrayBuffer): Promise<void>;
  update(patch: {heartbeat?: {everyMs: number; frame: Frame}; idleMs?: number; state?: Tracked}): Promise<void>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<{state: string; version: string; tracked: Tracked} | null>;
  checkMail(): Promise<unknown>;
  replyMail(input: unknown): Promise<{messageId: string}>;
  mailAttachment(input: unknown): Promise<{base64: string}>;
}
interface Handlers {
  /** Identifies the account behind the connection; a different version replaces the gateway's connection. */
  version?: string;
  open(state: Tracked): unknown;
  connected?(connection: Connection, state: Tracked): unknown;
  message?(data: string | Uint8Array, connection: Connection, state: Tracked): unknown;
  response?(body: unknown, connection: Connection, state: Tracked): unknown;
  failed?(body: unknown, connection: Connection, state: Tracked): unknown;
  /** Return false to stop; otherwise `open` is asked for a fresh specification. */
  closed?(info: {reason: string; code?: number}, connection: Connection, state: Tracked): unknown;
}

function frameOf(data: string | Uint8Array | ArrayBuffer): Frame {
  if (typeof data === 'string') return {text: data};
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return {base64: btoa(text)};
}
const bytesOf = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export class WorkerConnections {
  private readonly registered = new Map<string, {kind: 'socket' | 'poll' | 'mail'; handlers: Handlers; connection: Connection}>();
  constructor(private readonly host: Host) {}
  readonly service = {
    socket: (id: string, handlers: Handlers) => this.register(id, 'socket', handlers),
    poll: (id: string, handlers: Handlers) => this.register(id, 'poll', handlers),
    mail: (id: string, handlers: Handlers) => this.register(id, 'mail', handlers),
    /** Close a connection this activation does not register, e.g. a disabled channel's. */
    close: async (id: string) => {this.registered.delete(id); await this.host.connectionCall(id, 'close');},
  };

  private register(id: string, kind: 'socket' | 'poll' | 'mail', handlers: Handlers): Connection {
    if (!/^[\w.-]{1,64}$/.test(id)) throw new TypeError('Connection ids are 1-64 word characters, dots or dashes');
    if (typeof handlers?.open !== 'function') throw new TypeError('A connection needs an open(state) function');
    const call = (operation: string, argument?: unknown) => this.host.connectionCall(id, operation, argument);
    const connection: Connection = {
      id, ready: Promise.resolve(),
      send: async data => {await call('send', frameOf(data));},
      update: async patch => {await call('update', patch);},
      reconnect: async () => {await call('reconnect');},
      close: async () => {if (this.registered.get(id)?.connection === connection) this.registered.delete(id); await call('close');},
      status: async () => await call('status') as Awaited<ReturnType<Connection['status']>>,
      checkMail: () => call('mailCheck'),
      replyMail: async input => await call('mailReply', input) as {messageId: string},
      mailAttachment: async input => await call('mailAttachment', input) as {base64: string},
    };
    this.registered.set(id, {kind, handlers, connection});
    // Re-registration after a wake keeps the running connection unless its account changed.
    // A failed first open retries here, since the gateway holds nothing to retry yet.
    const ready = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const status = await connection.status();
          if (!status || status.version !== (handlers.version ?? '') || status.state === 'waiting') await this.reopen(id, status?.tracked ?? {});
          return;
        } catch (error) {
          if (attempt >= 5 || this.registered.get(id)?.connection !== connection) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    })();
    void ready.catch(error => console.warn(`weftConnections ${id}: ${error instanceof Error ? error.message : String(error)}`));
    Object.defineProperty(connection, 'ready', {value: ready});
    return connection;
  }
  private async reopen(id: string, state: Tracked): Promise<void> {
    const entry = this.registered.get(id);
    if (!entry) return;
    const spec = await entry.handlers.open({...state}) as Record<string, unknown>;
    if (this.registered.get(id) !== entry) return;
    await this.host.connectionOpen(id, entry.handlers.version ?? '', {...spec, kind: entry.kind});
  }
  /** Events of one connection, in order. A throw makes the gateway redeliver the batch. */
  async deliver(id: string, events: Event[]): Promise<'ok' | 'unknown'> {
    const entry = this.registered.get(id);
    if (!entry) return 'unknown';
    const {handlers, connection} = entry;
    for (const event of events) {
      const state = {...event.state};
      if (event.type === 'connected') await handlers.connected?.(connection, state);
      else if (event.type === 'frame' && event.data) await handlers.message?.('text' in event.data ? event.data.text : bytesOf(event.data.base64), connection, state);
      else if (event.type === 'response') await handlers.response?.(event.body, connection, state);
      else if (event.type === 'failed') await handlers.failed?.(event.body, connection, state);
      else if (event.type === 'closed') {
        if (await handlers.closed?.({reason: event.reason ?? 'closed', ...(event.code === undefined ? {} : {code: event.code})}, connection, state) === false) await connection.close();
        else await this.reopen(id, state);
      }
    }
    return 'ok';
  }
}
