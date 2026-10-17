import { RemoteError, isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteEventClientId, RemoteEventDownlinkFrame, RemoteEventEmitFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';

interface Observer<T> {
  queue: {frame: T; bytes: number}[];
  bytes: number;
  closed: boolean;
  wake?: () => void;
  failure?: Error;
}

/** One environment's ephemeral notifications; reconnect repulls authoritative DO state. */
export class NativeStreamHub<T> {
  private readonly observers = new Set<Observer<T>>();

  open(signal: AbortSignal, baseline: () => T | Promise<T>): AsyncIterable<T> {
    signal.throwIfAborted();
    if (this.observers.size >= 32) throw new RemoteError('gateway/internal', 'Too many event observers', {});
    const observer: Observer<T> = {queue: [], bytes: 0, closed: false};
    this.observers.add(observer);
    const close = () => {
      observer.closed = true;
      observer.queue.length = 0;
      observer.bytes = 0;
      this.observers.delete(observer);
      observer.wake?.();
      delete observer.wake;
      signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, {once: true});
    let initial: T | Promise<T>;
    try { initial = baseline(); } catch (error) {close(); throw error;}
    return (async function* () {
      try {
        const first = await initial;
        signal.throwIfAborted();
        yield first;
        while (!observer.closed) {
          const next = observer.queue.shift();
          if (next) { observer.bytes -= next.bytes; yield next.frame; }
          else await new Promise<void>(resolve => {observer.wake = resolve;});
        }
        if (observer.failure) throw observer.failure;
      } finally { close(); }
    })();
  }

  emit(frame: T): void {
    if (!isRemoteJsonValue(frame)) throw new Error('Native notification must be lossless JSON');
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    for (const observer of this.observers) {
      if (observer.bytes + bytes > 1_048_576) {
        observer.failure = new RemoteError('gateway/internal', 'Event observer exceeded its buffer; reconnect to refresh', {});
        observer.closed = true;
        observer.queue.length = 0;
        observer.bytes = 0;
        this.observers.delete(observer);
      } else { observer.queue.push({frame, bytes}); observer.bytes += bytes; }
      observer.wake?.();
      delete observer.wake;
    }
  }
}

export class NativeEventHub {
  private readonly stream = new NativeStreamHub<RemoteEventDownlinkFrame>();
  open(signal: AbortSignal): AsyncIterable<RemoteEventDownlinkFrame> {
    return this.stream.open(signal, () => ({type: 'ready', clientId: crypto.randomUUID() as RemoteEventClientId, host: {home: '/workspace'}}));
  }
  emit(event: string, args: readonly unknown[]): void {
    const frame: RemoteEventEmitFrame = {type: 'emit', event, args};
    this.stream.emit(frame);
  }
}
