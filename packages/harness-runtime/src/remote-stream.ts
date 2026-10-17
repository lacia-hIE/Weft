import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';

/** A decoded official Remote stream over Fetch; observer cancellation owns only its iterator. */
export function remoteStream(source: AsyncIterable<unknown>, abort: AbortController, validate: (value: unknown) => unknown = value => value): Response {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`event: item\ndata: ${JSON.stringify(validate(next.value))}\n\n`));
      } catch (error) {
        if (!abort.signal.aborted) {
          const failure = remoteErrorOf(error) ?? {code: 'gateway/internal', message: 'Remote stream failed', details: {}};
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({code: failure.code, message: failure.message, details: failure.details})}\n\n`));
        }
        controller.close();
      }
    },
    async cancel() { abort.abort(); await iterator.return?.(); },
  }, {highWaterMark: 65_536, size: chunk => chunk.byteLength});
  return new Response(body, {headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store'}});
}
