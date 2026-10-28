/** A root Session finished a turn; the plugin reads what it needs from its own cursor. */
export interface SessionTurnEnded {readonly sessionId: string; readonly seq: number}
export function sessionTurnEnded(raw: unknown): SessionTurnEnded {
  const value = raw as Partial<SessionTurnEnded> | null;
  if (!value || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256 || !Number.isSafeInteger(value.seq) || value.seq! < 0 || Object.keys(value).length !== 2)
    throw new TypeError('Invalid Session turn notification');
  return {sessionId: value.sessionId, seq: value.seq!};
}

interface Host {watchSession(sessionId: string, watch: boolean): Promise<void>}

/**
 * The plugin face of `weftSessionEvents`. Watches persist in the owning
 * environment; handlers are registered at activation and never persisted.
 */
export class WorkerSessionEvents {
  private readonly handlers = new Set<(event: SessionTurnEnded) => unknown>();
  constructor(private readonly host: Host) {}
  readonly service = {
    watch: (sessionId: string) => this.host.watchSession(String(sessionId), true),
    unwatch: (sessionId: string) => this.host.watchSession(String(sessionId), false),
    onTurnEnded: (handler: (event: SessionTurnEnded) => unknown) => {
      if (typeof handler !== 'function') throw new TypeError('onTurnEnded requires a function');
      this.handlers.add(handler);
      return () => {this.handlers.delete(handler);};
    },
  };
  /** Every handler runs; one failure does not hide the event from the others. */
  async deliver(raw: unknown): Promise<void> {
    const event = sessionTurnEnded(raw);
    const results = await Promise.allSettled([...this.handlers].map(handler => Promise.resolve().then(() => handler({...event}))));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
