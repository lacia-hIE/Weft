import {z} from 'zod';
export {passiveNativeStream} from '../../../../packages/harness-runtime/src/stream-carrier.ts';

const frame = z.discriminatedUnion('type', [
  z.object({type: z.literal('item'), value: z.unknown()}),
  z.object({type: z.literal('error'), error: z.object({code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown())})}),
]);

/** Marker consumed by the original Gateway across separately bundled modules. */
function carrierFailure(message: string): Error {
  return Object.assign(new Error(message), {dshRemoteStreamFailure: {kind: 'carrier' as const}});
}

export async function* socketStream(base: string, endpoint: string, payload: unknown, signal: AbortSignal): AsyncGenerator<unknown> {
  signal.throwIfAborted();
  const url = new URL(`${base}/sockets/${endpoint}`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('payload', JSON.stringify(payload));
  const socket = new WebSocket(url);
  const pending: unknown[] = [];
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {wake?.(); wake = undefined;};
  const aborted = () => {socket.close(); notify();};
  signal.addEventListener('abort', aborted, {once: true});
  socket.onmessage = event => {
    try {
      const item = frame.parse(JSON.parse(String(event.data)));
      if (item.type === 'error') failure = Object.assign(new Error(item.error.message), item.error, {dshRemoteStreamFailure: {kind: 'remote' as const, code: item.error.code, details: item.error.details}});
      else {
        if (pending.length >= 512) throw carrierFailure('Native subscription consumer is too slow');
        pending.push(item.value);
      }
    } catch (error) {failure = error instanceof Error ? error : carrierFailure('Invalid native stream frame'); socket.close();}
    notify();
  };
  socket.onerror = () => {failure ??= carrierFailure('Native subscription connection failed'); notify();};
  socket.onclose = () => {failure ??= carrierFailure('Native subscription generation ended'); notify();};
  try {
    for (;;) {
      signal.throwIfAborted();
      while (pending.length) {yield pending.shift(); signal.throwIfAborted();}
      if (failure) throw failure;
      await new Promise<void>(resolve => {wake = resolve;});
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
  }
}
