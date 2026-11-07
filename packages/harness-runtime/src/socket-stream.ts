import {remoteErrorOf} from '@deepseek-ai/dsh-typert-protocol';

const tag = 'weft-native-stream';

/** Hibernatable carrier for passive native subscriptions, never an Agent owner. */
export class NativeSocketStreams {
  private readonly active = new Map<WebSocket, () => void>();

  constructor(private readonly state: DurableObjectState) {
    // A native iterator and its baseline belong to one in-memory generation.
    // After eviction ask the original Client supervisor for a fresh generation;
    // silently attaching a second baseline would corrupt its journal protocol.
    for (const socket of state.getWebSockets(tag)) socket.close(1012, 'Restore native stream generation');
  }

  async open(source: AsyncIterable<unknown>, abort: AbortController, validate: (value: unknown) => unknown = value => value, dispose?: () => void | Promise<void>): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0], socket = pair[1];
    const iterator = source[Symbol.asyncIterator]();
    let closing: Promise<void> | undefined;
    const stop = () => {
      if (closing) return closing;
      this.active.delete(socket);
      abort.abort();
      closing = (async () => {try {await iterator.return?.();} finally {await dispose?.();}})();
      return closing;
    };
    const fail = (error: unknown) => {
      if (!abort.signal.aborted) {
        const remote = remoteErrorOf(error);
        if (!remote) console.warn('weft.native.subscription.failed', error);
        const failure = remote ?? {code: 'gateway/internal', message: 'Remote stream failed', details: {}};
        try {socket.send(JSON.stringify({type: 'error', error: {code: failure.code, message: failure.message, details: failure.details}}));} catch {}
      }
    };
    const send = (item: IteratorResult<unknown>) => {
      if (item.done) return false;
      socket.send(JSON.stringify({type: 'item', value: validate(item.value)}));
      return true;
    };
    this.state.acceptWebSocket(socket, [tag]);
    this.active.set(socket, () => {socket.close(1000, 'Subscription closed'); void stop().catch(() => {});});
    try {
      // Finish ownership checks and the opening baseline in the upgrade request.
      // Only the passive queue below is detached, not initialization I/O.
      const first = await iterator.next();
      if (send(first)) {
        // Deliberately not waitUntil: a passive JS queue is allowed to disappear
        // on hibernation. Genuine Agent work keeps its existing waitUntil owner.
        void (async () => {
          try {
            for (;;) {
              const item = await iterator.next();
              if (abort.signal.aborted || !send(item)) break;
            }
          } catch (error) {fail(error);}
          finally {socket.close(1000, 'Subscription ended'); await stop();}
        })().catch(() => {});
      } else {socket.close(1000, 'Subscription ended'); await stop();}
    } catch (error) {fail(error); socket.close(1000, 'Subscription failed'); await stop();}
    return new Response(null, {status: 101, webSocket: client});
  }

  closed(socket: WebSocket): void {this.active.get(socket)?.();}
  message(socket: WebSocket): void {socket.close(1008, 'Read-only subscription'); this.closed(socket);}
  close(): void {for (const stop of [...this.active.values()]) stop();}
}
