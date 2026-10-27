/** Helpers shared by the bridge and its channels; Worker and Node runtimes both provide these globals. */

const encoder = new TextEncoder();
export const bytes = text => encoder.encode(text);
export const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
export const fromHex = text => new Uint8Array((text.match(/../g) ?? []).map(pair => Number.parseInt(pair, 16)));
export async function sha256(value) {return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? bytes(value) : value));}

/** A stable request identity for one channel message, so a redelivery is the same prompt. */
export async function requestId(key) {
  const digest = await sha256('weft-dsh-im:' + key);
  digest[6] = digest[6] & 0x0f | 0x40; digest[8] = digest[8] & 0x3f | 0x80;
  const h = hex(digest.subarray(0, 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Split text at paragraph, line or space boundaries so each part fits a channel's limit. */
export function chunks(text, limit) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const end = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The raw body of a native webServer request, at most what the carrier admits. */
export async function readBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) {result.set(part, offset); offset += part.length;}
  return result;
}
export function json(response, status, value) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}
export const header = (request, name) => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

/** Run background work owned by a plugin context; disposal aborts it. */
export function background(ctx, name, work) {
  const controller = new AbortController();
  const dispose = ctx.effect(() => () => controller.abort(new Error(name + ' stopped')), name);
  const pending = Promise.resolve().then(() => work(controller.signal)).catch(error => {
    if (!controller.signal.aborted) console.warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {void Promise.resolve(typeof dispose === 'function' ? dispose() : undefined).catch(() => {});});
  return {signal: controller.signal, abort: reason => controller.abort(reason), pending};
}
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {clearTimeout(timer); reject(signal.reason);}, {once: true});
});

/** A cached bearer token refreshed shortly before it expires. */
export function tokenCache(fetchToken) {
  let current;
  return {
    async get() {
      if (current && current.expiresAt - 60_000 > Date.now()) return current.value;
      current = await fetchToken();
      return current.value;
    },
    clear() {current = undefined;},
  };
}
