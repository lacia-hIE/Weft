/** What one activation's egress may hold open. Session plugins answer within a turn; environment Hosts keep long polls and sockets. */
export interface EgressLimits {
  /** Until response headers arrive (a long poll holds them back). */
  headerMs: number;
  /** Without a response chunk, after headers; the whole exchange for buffered egress. */
  idleMs: number;
  maxRequestBytes: number; maxResponseBytes: number;
  /** Streamed bodies and sockets recheck authorization this often; 0 buffers the whole response instead. */
  recheckMs: number;
  /** Bridge outbound WebSocket upgrades. */
  websocket: boolean;
  /** Largest relayed WebSocket message. */
  maxMessageBytes: number;
}
export const sessionEgress: EgressLimits = {headerMs: 15_000, idleMs: 15_000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, recheckMs: 0, websocket: false, maxMessageBytes: 0};
export const environmentEgress: EgressLimits = {headerMs: 120_000, idleMs: 300_000, maxRequestBytes: 16_777_216, maxResponseBytes: 67_108_864, recheckMs: 30_000, websocket: true, maxMessageBytes: 1_048_576};

function destination(raw: string): URL {
  const url = new URL(raw);
  // The WebSocket constructor's handshake is an ordinary HTTPS request.
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !url.hostname.includes('.') || /[:\[\]]/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname)) throw new Error('Plugin network destination is not allowed');
  return url;
}
function forwarded(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const key of ['host', 'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret']) headers.delete(key);
  return headers;
}
async function bytes(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal, label: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  signal.throwIfAborted();
  if (!body) return undefined;
  const reader = body.getReader(), parts: Uint8Array[] = []; let size = 0;
  const cancel = () => {void reader.cancel(signal.reason).catch(() => {});};
  signal.addEventListener('abort', cancel, {once: true});
  try {for (;;) {signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.length; if (size > limit) {await reader.cancel(); throw new Error(`Plugin network ${label} exceeds ${limit / 1_048_576} MiB`);} parts.push(part.value);}}
  finally {signal.removeEventListener('abort', cancel); reader.releaseLock();}
  const result = new Uint8Array(size); let offset = 0; for (const part of parts) {result.set(part, offset); offset += part.length;} return result;
}

/** Bounded HTTPS egress. Authorization is rechecked by the owning environment. */
export async function pluginFetch(request: Request, authorized: () => Promise<void>, limits: EgressLimits = sessionEgress): Promise<Response> {
  await authorized();
  const url = destination(request.url);
  const upgrade = request.headers.get('upgrade');
  if (upgrade) {
    if (!limits.websocket || upgrade.toLowerCase() !== 'websocket') throw new Error('Plugin WebSocket upgrades are not bridged');
    return socket(url, request, authorized, limits);
  }
  if (!limits.recheckMs) {
    const abort = AbortSignal.any([request.signal, AbortSignal.timeout(limits.idleMs)]);
    const body = await bytes(request.body, limits.maxRequestBytes, abort, 'body');
    await authorized();
    const response = await fetch(url, {method: request.method, headers: forwarded(request), ...(body ? {body} : {}), signal: abort, redirect: 'manual'});
    // A redirect is returned to the plugin; following it is a separately admitted request.
    const received = await bytes(response.body, limits.maxResponseBytes, abort, 'body');
    await authorized();
    return new Response(received, {status: response.status, statusText: response.statusText, headers: response.headers});
  }
  const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal]);
  const body = await bytes(request.body, limits.maxRequestBytes, AbortSignal.any([signal, AbortSignal.timeout(limits.idleMs)]), 'request body');
  await authorized();
  const waiting = setTimeout(() => controller.abort(new Error('Plugin network response headers timed out')), limits.headerMs);
  let response: Response;
  try {response = await fetch(url, {method: request.method, headers: forwarded(request), ...(body ? {body} : {}), signal, redirect: 'manual'});}
  finally {clearTimeout(waiting);}
  await authorized();
  if (!response.body) return new Response(null, {status: response.status, statusText: response.statusText, headers: response.headers});
  const reader = response.body.getReader();
  let size = 0, checked = Date.now(), idle: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: Error) => {controller.abort(error); void reader.cancel(error).catch(() => {});};
  // Long polls and event streams pass through as they arrive; the budget, idle
  // limit and revocation end the stream instead of buffering it.
  const stream = new ReadableStream<Uint8Array>({
    async pull(output) {
      idle = setTimeout(() => fail(new Error('Plugin network response was idle too long')), limits.idleMs);
      try {
        const part = await reader.read();
        if (part.done) {output.close(); return;}
        size += part.value.length;
        if (size > limits.maxResponseBytes) throw new Error(`Plugin network body exceeds ${limits.maxResponseBytes / 1_048_576} MiB`);
        if (Date.now() - checked >= limits.recheckMs) {await authorized(); checked = Date.now();}
        output.enqueue(part.value);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        output.error(error);
      } finally {clearTimeout(idle);}
    },
    cancel(reason) {clearTimeout(idle); controller.abort(reason); return reader.cancel(reason);},
  });
  return new Response(stream, {status: response.status, statusText: response.statusText, headers: response.headers});
}

/** Codes a peer may send; reserved and absent codes close normally. */
const closeCode = (code: number) => code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1000;
const messageSize = (data: unknown) => typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : data instanceof Blob ? data.size : 0;
/**
 * Relay one outbound WebSocket through a pair the plugin holds. The relay owns
 * the remote socket, so revocation and the message budget close both sides.
 */
async function socket(url: URL, request: Request, authorized: () => Promise<void>, limits: EgressLimits): Promise<Response> {
  const response = await fetch(url, {headers: forwarded(request), signal: AbortSignal.any([request.signal, AbortSignal.timeout(limits.headerMs)])});
  const remote = response.webSocket;
  if (!remote) return new Response(response.body, {status: response.status, statusText: response.statusText, headers: response.headers});
  await authorized().catch(error => {remote.accept(); remote.close(1008, 'Plugin network capability was revoked'); throw error;});
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  // Binary frames must remain bytes across both relay legs. With the browser
  // default, message.data is a Blob and send() coerces it to "[object Blob]".
  remote.binaryType = 'arraybuffer'; server.binaryType = 'arraybuffer';
  remote.accept(); server.accept();
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return; closed = true; clearInterval(timer);
    for (const peer of [server, remote]) try {peer.close(closeCode(code), reason.slice(0, 120));} catch { /* Already closed. */ }
  };
  const relay = (from: WebSocket, to: WebSocket) => {
    from.addEventListener('message', event => {
      if (messageSize(event.data) > limits.maxMessageBytes) {close(1009, 'Plugin WebSocket message is too large'); return;}
      try {to.send(event.data as string | ArrayBuffer);} catch {close(1011, 'Plugin WebSocket relay failed');}
    });
    from.addEventListener('close', event => close(event.code, event.reason));
    from.addEventListener('error', () => close(1011, 'Plugin WebSocket relay failed'));
  };
  relay(server, remote); relay(remote, server);
  const timer = setInterval(() => {void authorized().catch(() => close(1008, 'Plugin network capability was revoked'));}, limits.recheckMs);
  const protocol = response.headers.get('sec-websocket-protocol');
  return new Response(null, {status: 101, webSocket: client, ...(protocol ? {headers: {'sec-websocket-protocol': protocol}} : {})});
}
