/** Decode the existing native Remote SSE carrier; cancellation closes its observer. */
export async function* pluginSessionStream(response: Response, signal?: AbortSignal): AsyncIterable<unknown> {
  if (!response.ok || !response.body) throw new Error('Session stream could not be opened');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
  const cancel = () => {void reader.cancel().catch(() => {});};
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read(); if (part.done) return;
      pending += decoder.decode(part.value, {stream: true});
      if (pending.length > 1_048_576) throw new Error('Session stream frame exceeds 1 MiB');
      for (let boundary; (boundary = pending.indexOf('\n\n')) >= 0;) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
        if (!data) continue;
        if (frame.startsWith('event: error')) throw new Error('Session stream failed');
        if (frame.startsWith('event: item')) yield JSON.parse(data);
      }
    }
  } finally {signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock();}
}
