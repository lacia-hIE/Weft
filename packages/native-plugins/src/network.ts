/** Bounded HTTPS egress. Authorization is rechecked by the owning environment. */
export async function pluginFetch(request: Request, authorized: () => Promise<void>): Promise<Response> {
  await authorized();
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !url.hostname.includes('.') || /[:\[\]]/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname)) throw new Error('Plugin network destination is not allowed');
  if (request.headers.get('upgrade')) throw new Error('Plugin WebSocket upgrades are not bridged');
  const abort = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const limit = 1_048_576;
  const read = async (body: ReadableStream<Uint8Array> | null) => {
    abort.throwIfAborted();
    if (!body) return undefined;
    const reader = body.getReader(), parts: Uint8Array[] = []; let size = 0;
    const cancel = () => {void reader.cancel(abort.reason).catch(() => {});};
    abort.addEventListener('abort', cancel, {once: true});
    try {for (;;) {abort.throwIfAborted(); const part = await reader.read(); abort.throwIfAborted(); if (part.done) break; size += part.value.length; if (size > limit) {await reader.cancel(); throw new Error('Plugin network body exceeds 1 MiB');} parts.push(part.value);}}
    finally {abort.removeEventListener('abort', cancel); reader.releaseLock();}
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) {bytes.set(part, offset); offset += part.length;} return bytes;
  };
  const body = await read(request.body);
  await authorized();
  const headers = new Headers(request.headers);
  for (const key of ['host', 'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret']) headers.delete(key);
  const response = await fetch(url, {method: request.method, headers, ...(body ? {body} : {}), signal: abort, redirect: 'manual'});
  // A redirect is returned to the plugin; following it is a separately admitted request.
  const bytes = await read(response.body);
  await authorized();
  return new Response(bytes, {status: response.status, statusText: response.statusText, headers: response.headers});
}
