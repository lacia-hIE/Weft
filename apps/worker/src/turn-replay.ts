import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** The terminal frame of one turn, as the originating SSE request reported it. */
export type TurnEnding = { event: 'done' | 'error'; data: Record<string, unknown> };
export type ReplayFrame = { event: 'session-event'; id: number; data: SessionEvent } | TurnEnding | { event: 'idle'; data: { seq: number } };
type Item = { kind: 'event'; value: SessionEvent } | { kind: 'end'; ending: TurnEnding; idle: boolean };

// Root events between emission and commit; persistence flushes far sooner than this.
const PENDING_LIMIT = 4096;

/**
 * Root Session events of the running turn that may not be committed yet. A
 * resumed reader takes committed rows first and this suffix after them, so
 * Last-Event-ID resumption is gap-free without waiting for the turn queue.
 */
export class TurnReplay {
  private pending: SessionEvent[] = [];
  private readonly listeners = new Set<(item: Item) => void>();

  begin(): void { this.pending = []; }
  event(event: SessionEvent): void {
    if (this.pending.length >= PENDING_LIMIT) this.pending.shift();
    this.pending.push(event);
    for (const listener of this.listeners) listener({ kind: 'event', value: event });
  }
  /** @param idle - no request is active or queued after this turn. */
  end(ending: TurnEnding, idle: boolean): void {
    this.pending = [];
    for (const listener of this.listeners) listener({ kind: 'end', ending, idle });
  }
  /** Highest seq a reader may already hold: committed or still pending. */
  known(committedCount: number): number { return Math.max(committedCount - 1, this.pending.at(-1)?.seq ?? -1); }

  /**
   * Events after `after`, then live turns until no request remains.
   * @param committed - committed events from a seq onward (a bounded page; empty when none).
   * @param idle - whether no request is active or queued.
   */
  async *follow(after: number, committed: (from: number) => readonly SessionEvent[], idle: () => boolean, signal: AbortSignal): AsyncGenerator<ReplayFrame> {
    // Snapshot and subscribe in one synchronous step: every root event is then committed, pending or queued here.
    const queue: Item[] = this.pending.filter(event => event.seq > after).map(value => ({ kind: 'event', value }));
    let wake: (() => void) | undefined;
    const listener = (item: Item) => { queue.push(item); wake?.(); };
    const aborted = () => wake?.();
    this.listeners.add(listener);
    signal.addEventListener('abort', aborted, { once: true });
    let last = after;
    try {
      while (!signal.aborted) {
        const rows = committed(last + 1);
        if (rows.length) {
          for (const event of rows) yield { event: 'session-event', id: event.seq, data: event };
          last = rows.at(-1)!.seq;
          continue;
        }
        const item = queue.shift();
        if (!item) {
          if (idle()) { yield { event: 'idle', data: { seq: last } }; return; }
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
          continue;
        }
        if (item.kind === 'end') {
          yield item.ending;
          if (item.idle) return;
          continue;
        }
        if (item.value.seq <= last) continue;
        if (item.value.seq !== last + 1) {
          yield { event: 'error', data: { code: 'RESUME_GAP', message: 'Session events after the cursor are no longer buffered; read the log', status: 410 } };
          return;
        }
        yield { event: 'session-event', id: item.value.seq, data: item.value };
        last = item.value.seq;
      }
    } finally {
      this.listeners.delete(listener);
      signal.removeEventListener('abort', aborted);
    }
  }
}
