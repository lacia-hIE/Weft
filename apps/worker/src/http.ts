export async function readJson(request: Request, limit = 16_384): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing JSON body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Message body is too large');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(body)) as unknown; }
  catch { throw new HttpError(400, 'Invalid message body'); }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'Cross-origin writes are not allowed');
  }
}
