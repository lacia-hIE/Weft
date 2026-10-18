import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';

/** A decoded official Remote stream over Fetch; observer cancellation owns only its iterator. */
export function remoteStream(source: AsyncIterable<unknown>, abort: AbortController, validate: (value: unknown) => unknown = value => value, dispose?: () => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  let cancelled = false;
  let disposal: Promise<void> | undefined;
  const finish = () => disposal ??= Promise.resolve().then(dispose);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) {await finish(); controller.close();}
        else controller.enqueue(encoder.encode(`event: item\ndata: ${JSON.stringify(validate(next.value))}\n\n`));
      } catch (error) {
        if (cancelled) {await finish(); return;}
        if (!abort.signal.aborted) {
          const failure = remoteErrorOf(error) ?? {code: 'gateway/internal', message: 'Remote stream failed', details: {}};
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({code: failure.code, message: failure.message, details: failure.details})}\n\n`));
        }
        await finish();
        controller.close();
      }
    },
    async cancel() { cancelled = true; abort.abort(); try {await iterator.return?.();} finally {await finish();} },
  }, {highWaterMark: 65_536, size: chunk => chunk.byteLength});
  return new Response(body, {headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store'}});
}
