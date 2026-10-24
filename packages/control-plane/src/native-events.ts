import { RemoteError, isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteEventAgentId, RemoteEventClientId, RemoteEventDownlinkFrame, RemoteEventEmitFrame, RemoteEventId, RemoteEventInvocationFrame, RemoteEventResult } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';

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

  open(signal: AbortSignal, baseline: () => T | Promise<T>, attach?: (push: (frame: T) => void) => () => void): AsyncIterable<T> {
    signal.throwIfAborted();
    if (this.observers.size >= 32) throw new RemoteError('gateway/internal', 'Too many event observers', {});
    const observer: Observer<T> = {queue: [], bytes: 0, closed: false};
    this.observers.add(observer);
    let detach: (() => void) | undefined;
    const close = () => {
      detach?.();
      detach = undefined;
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
    if (attach) detach = attach(frame => {this.push(observer, frame);});
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
    for (const observer of this.observers) this.push(observer, frame);
  }
  close():void {for(const observer of this.observers){observer.closed=true;observer.queue.length=0;observer.wake?.();}this.observers.clear();}

  private push(observer: Observer<T>, frame: T): void {
    if (observer.closed) return;
    if (!isRemoteJsonValue(frame)) throw new Error('Native notification must be lossless JSON');
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
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

/** Settlement of one forwarded waterfall, as the official gateway reports it to the Host listener. */
export type NativeWaterfallOutcome =
  | {kind: 'next'}
  | {kind: 'result'; value?: unknown}
  | {kind: 'rejected'; error: {name: string; message: string; code?: string; details?: unknown}};

interface PendingWaterfall {
  frame: RemoteEventInvocationFrame;
  deliveries: Set<RemoteEventClientId>;
  settle(outcome: NativeWaterfallOutcome): void;
}

/**
 * Environment Remote Events with the official gateway's waterfall semantics:
 * each live owner stream receives the request, the first result settles it,
 * a request waits for a stream when none is open, and settlement cancels the
 * other deliveries. Pending requests live only in this instance's memory.
 */
export class NativeEventHub {
  private readonly stream = new NativeStreamHub<RemoteEventDownlinkFrame>();
  private readonly clients = new Map<RemoteEventClientId, (frame: RemoteEventDownlinkFrame) => void>();
  private readonly pending = new Map<RemoteEventId, PendingWaterfall>();
  close():void {for(const pending of this.pending.values())pending.settle({kind:'rejected',error:{name:'AbortError',message:'Environment stopped'}});this.clients.clear();this.stream.close();}

  open(signal: AbortSignal): AsyncIterable<RemoteEventDownlinkFrame> {
    const clientId = crypto.randomUUID() as RemoteEventClientId;
    return this.stream.open(signal, () => ({type: 'ready', clientId, host: {home: '/workspace'}}), push => {
      this.clients.set(clientId, push);
      for (const waterfall of this.pending.values()) this.deliver(waterfall, clientId, push);
      return () => {
        this.clients.delete(clientId);
        for (const waterfall of this.pending.values()) waterfall.deliveries.delete(clientId);
      };
    });
  }

  emit(event: string, args: readonly unknown[]): void {
    const frame: RemoteEventEmitFrame = {type: 'emit', event, args};
    this.stream.emit(frame);
  }

  /** Forward one Agent-scoped waterfall; the promise settles with the first client outcome. */
  waterfall(eventId: string, event: string, agentId: string, request: Record<string, unknown>): Promise<NativeWaterfallOutcome> {
    if (!isRemoteJsonValue(request)) throw new Error('Remote event request must be lossless JSON');
    const id = eventId as RemoteEventId;
    if (this.pending.has(id)) throw new RemoteError('gateway/bad-request', 'Duplicate Remote event identity', {});
    return new Promise(resolve => {
      const waterfall: PendingWaterfall = {
        frame: {type: 'waterfall', event, eventId: id, agentId: agentId as RemoteEventAgentId, request},
        deliveries: new Set(),
        settle: outcome => {
          if (this.pending.get(id) !== waterfall) return;
          this.pending.delete(id);
          for (const clientId of waterfall.deliveries) this.clients.get(clientId)?.({type: 'cancel', eventId: id});
          waterfall.deliveries.clear();
          resolve(outcome);
        },
      };
      this.pending.set(id, waterfall);
      for (const [clientId, push] of this.clients) this.deliver(waterfall, clientId, push);
    });
  }

  /** The Host listener was cancelled; withdraw every delivery. */
  cancel(eventId: string): void {
    this.pending.get(eventId as RemoteEventId)?.settle({kind: 'rejected', error: {name: 'AbortError', message: 'Remote event was cancelled'}});
  }

  /** Apply a client result; results from superseded deliveries are no-ops. */
  result(result: RemoteEventResult): void {
    if (!this.clients.has(result.clientId)) throw new RemoteError('gateway/bad-request', 'Remote event result identifies no active event stream', {});
    const waterfall = this.pending.get(result.eventId);
    if (!waterfall?.deliveries.has(result.clientId)) return;
    waterfall.deliveries.delete(result.clientId);
    if (result.outcome.kind === 'next') {
      if (waterfall.deliveries.size === 0) waterfall.settle({kind: 'next'});
    } else waterfall.settle(result.outcome);
  }

  private deliver(waterfall: PendingWaterfall, clientId: RemoteEventClientId, push: (frame: RemoteEventDownlinkFrame) => void): void {
    waterfall.deliveries.add(clientId);
    push(waterfall.frame);
  }
}
