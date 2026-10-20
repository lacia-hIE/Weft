import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { carrierKeyOf } from '@deepseek-ai/dsh-scope';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-user-approval';

export type WaterfallOutcome =
  | {kind: 'next'}
  | {kind: 'result'; value?: unknown}
  | {kind: 'rejected'; error: {name: string; message: string; code?: string; details?: unknown}};

export interface WaterfallTransport {
  forward(eventId: string, event: string, agentId: string, request: Record<string, unknown>): Promise<WaterfallOutcome>;
  cancel(eventId: string): Promise<void>;
}

/** The gateway's request projection: the Agent and signal stay local, the rest must be lossless JSON. */
function projectRequest(value: object, agent: Agent): {request: Record<string, unknown>; signal?: AbortSignal} {
  if (Reflect.get(value, 'agent') !== agent) throw new TypeError('Remote event request must carry its scoped Agent directly');
  const signal: unknown = Reflect.get(value, 'signal');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Remote event request signal must be an AbortSignal');
  const request: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (key !== 'agent' && key !== 'signal') request[key] = entry;
  if (!isRemoteJsonValue(request)) throw new TypeError('Remote event request is not lossless JSON data');
  return {request, ...(signal === undefined ? {} : {signal})};
}

function restoreRejection(rejection: {name: string; message: string; code?: string; details?: unknown}): Error {
  const error = new Error(rejection.message) as Error & {code?: string; details?: unknown};
  error.name = rejection.name;
  if (rejection.code !== undefined) error.code = rejection.code;
  if (rejection.details !== undefined) error.details = rejection.details;
  return error;
}

/**
 * Forward Agent-scoped waterfalls to the environment's Remote Events clients,
 * with the listener semantics of the official `api-remotes` bridge: a request
 * no client answers falls through to `next()`.
 */
export function forwardNativeWaterfalls(ctx: Context, events: readonly string[], transport: WaterfallTransport): void {
  for (const event of events) {
    ctx.on(event as 'user-questions/request', (async function (this: unknown, request: object, next: () => unknown) {
      const carrier = carrierKeyOf(this);
      if (carrier === undefined) return next();
      const agent = (request as {readonly agent?: Agent}).agent;
      if (agent === undefined || agent !== carrier) throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`);
      const projected = projectRequest(request, agent);
      projected.signal?.throwIfAborted();
      const eventId = crypto.randomUUID();
      const abort = () => { void transport.cancel(eventId).catch(() => { /* The pending forward settles or fails on its own. */ }); };
      projected.signal?.addEventListener('abort', abort, {once: true});
      let outcome: WaterfallOutcome;
      try { outcome = await transport.forward(eventId, event, agent.id, projected.request); }
      finally { projected.signal?.removeEventListener('abort', abort); }
      if (projected.signal?.aborted) throw projected.signal.reason;
      if (outcome.kind === 'result') return outcome.value;
      if (outcome.kind === 'rejected') throw restoreRejection(outcome.error);
      return next();
    }) as never);
  }
}
