import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

/** The generated Remote descriptor fields the direct Agent dispatcher reads. */
interface RemoteParameter { name: string; wire?: string; source: string; lookup?: string }
interface RemoteMethod {
  service: string;
  implementation?: string;
  invocation: {kind: string};
  parameters: readonly RemoteParameter[];
  cancellation?: unknown;
  mode?: string;
  uplink?: {codec: {create(): {parse(value: unknown): unknown}}};
  input(options: {strict: boolean}): {create(): {parse(value: unknown): Record<string, unknown>}};
  result: {create(): {parse(value: unknown): unknown}};
}
export interface RemoteInfo { methods: Record<string, unknown> }

// Cordis binds a Service's `this.ctx` to the Context that reads it, so a Service
// mounted under isolated scopes must be read through its own scope.
const receivers = new WeakMap<Context, Map<string, Context>>();
export function setRemoteReceiver(root: Context, service: string, receiver: Context): void {
  const map = receivers.get(root) ?? new Map<string, Context>();
  map.set(service, receiver);
  receivers.set(root, map);
}

function methodOf(info: RemoteInfo, endpoint: string): RemoteMethod {
  if (!Object.hasOwn(info.methods, endpoint)) throw new RemoteError('gateway/method-unavailable', 'Remote method is not connected yet', {endpoint});
  const method = info.methods[endpoint] as RemoteMethod;
  if (method.invocation.kind !== 'direct' || method.parameters.some(parameter => parameter.source !== 'json' && !(parameter.source === 'lookup' && parameter.lookup === 'agent'))) {
    throw new RemoteError('gateway/method-unavailable', 'Remote method is not connected yet', {endpoint});
  }
  return method;
}

/** The Session a direct method addresses (its Agent lookup, else `sessionId` or `request.sessionId`), for DO routing. */
export function remoteAgentId(info: RemoteInfo, endpoint: string, raw: unknown): string {
  const method = methodOf(info, endpoint);
  const args = method.input({strict: true}).create().parse(raw);
  const parameter = method.parameters.find(item => item.source === 'lookup');
  const request = args.request;
  const value = parameter ? args[parameter.wire ?? parameter.name] : typeof args.sessionId === 'string' ? args.sessionId : request && typeof request === 'object' ? Reflect.get(request, 'sessionId') : undefined;
  if (typeof value !== 'string') throw new RemoteError('gateway/method-unavailable', 'Remote method is not Agent-scoped', {endpoint});
  return value;
}

/** Bind one direct method as the official gateway does: strict wire codecs, live Agent lookups, JSON parameters in order, then the signal. */
function bind(ctx: Context, info: RemoteInfo, endpoint: string, raw: unknown, signal: AbortSignal, mode: 'unary' | 'stream', uplink?: AsyncIterable<unknown>) {
  const method = methodOf(info, endpoint);
  if ((method.mode === 'stream') !== (mode === 'stream')) throw new RemoteError('gateway/method-unavailable', `Remote method requires the ${method.mode === 'stream' ? 'stream' : 'RPC'} carrier`, {endpoint});
  const args = method.input({strict: true}).create().parse(raw);
  const scope = receivers.get(ctx)?.get(method.service) ?? ctx;
  // Like the gateway, the call runs on a Service view whose `ctx.invocation` carries this call and its client uplink.
  const codec = method.uplink?.codec.create();
  const invocation = {request: {namespace: endpoint.slice(0, endpoint.indexOf('/')), method: endpoint.slice(endpoint.indexOf('/') + 1), args}, signal, uplinkWindow: undefined,
    uplink: () => {
      if (!uplink || !codec) throw new RemoteError('gateway/method-unavailable', 'This Remote call has no client uplink', {endpoint});
      return (async function* () { for await (const item of uplink) yield codec.parse(item); })();
    }};
  const receiver: unknown = scope.extend({invocation} as never).get(method.service as never);
  const implementation = method.implementation ?? endpoint.slice(endpoint.indexOf('/') + 1);
  const fn: unknown = receiver && typeof receiver === 'object' ? Reflect.get(receiver, implementation) : undefined;
  if (typeof fn !== 'function') throw new RemoteError('gateway/method-unavailable', 'Remote Service is not mounted in this environment', {endpoint});
  const parameters: unknown[] = method.parameters.map(parameter => {
    if (parameter.source === 'json') return args[parameter.wire ?? parameter.name];
    const id = args[parameter.wire ?? parameter.name];
    const agent: Agent | undefined = typeof id === 'string' ? ctx.agents.get(SessionId(id)) : undefined;
    if (!agent) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(String(id))});
    return agent;
  });
  if (method.cancellation !== undefined) parameters.push(signal);
  return {codec: method.result.create(), call: () => Reflect.apply(fn, receiver, parameters) as unknown};
}

/** Invoke one unary Remote method on the root Context's Service. */
export async function invokeAgentRemote(ctx: Context, info: RemoteInfo, endpoint: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
  const bound = bind(ctx, info, endpoint, raw, signal, 'unary');
  return bound.codec.parse(await bound.call());
}

/** Open one stream Remote method with the same binding. */
export function openRemoteStream(ctx: Context, info: RemoteInfo, endpoint: string, raw: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>): {items: AsyncIterable<unknown>; parse(value: unknown): unknown} {
  const bound = bind(ctx, info, endpoint, raw, signal, 'stream', uplink);
  return {items: bound.call() as AsyncIterable<unknown>, parse: value => bound.codec.parse(value)};
}
