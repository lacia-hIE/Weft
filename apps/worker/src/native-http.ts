import { z } from 'zod';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@weft/upstream/packages/api/gateway/src/remote-error-codes.ts';
import { clientRequestSchema } from '@weft/upstream/packages/client/connection/src/rpc-schema.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import { controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';
import { sessionAddress, scopeSchema, type Principal } from '../../../packages/tenant/src/index.ts';
import type { Env } from './index.ts';
import { assertSameOrigin, HttpError, readJson } from './http.ts';

const payloadSchema = z.object({args: z.unknown()}).strict();
type Endpoint = keyof typeof sessionRemote.methods;

/** Official Connection envelopes and generated codecs at the CF host boundary. */
export async function handleNativeRequest(request: Request, env: Env, principal: Principal, environmentId?: string): Promise<Response | undefined> {
  const match = /^\/v1\/tenants\/([^/]+)\/native\/(api|streams)\/(.+)$/.exec(new URL(request.url).pathname);
  if (!match) return undefined;
  if (match[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
  if (request.method !== 'POST') throw new HttpError(405, 'Expected POST');
  assertSameOrigin(request);
  const owner = controlScope(principal.tenantId, environmentId);
  const control = controlFor(env, owner);
  const endpoint = match[3]!;
  let rpcId = 'invalid-request';
  const session = (sessionId: string) => {
    const scope = scopeSchema.parse({tenantId: principal.tenantId, sessionId, ...(environmentId ? {environmentId} : {})});
    return {scope, stub: env.SESSIONS.getByName(sessionAddress(scope))};
  };
  const notFound = (sessionId: string): never => { throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(sessionId)}); };
  try {
    const raw = await readJson(request, 65_536);
    if (match[2] === 'streams') {
      if (endpoint !== 'session/follow') throw new RemoteError('gateway/method-unavailable', 'Remote stream is not connected yet', {endpoint});
      const payload = payloadSchema.parse(raw);
      const args = sessionRemote.methods['session/follow'].input({strict: true}).create().parse(payload.args);
      if (args.request.address.kind !== 'session') throw new RemoteError('gateway/method-unavailable', 'Subagent history is not connected yet', {endpoint});
      const target = session(args.request.address.sessionId);
      return await target.stub.fetch(new Request('https://session.internal/native-follow', {
        method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-follow', args}), signal: request.signal,
      }));
    }
    const envelope = clientRequestSchema.parse(raw);
    rpcId = envelope.rpcId;
    if (envelope.method !== endpoint) throw new RemoteError('gateway/bad-request', 'RPC method does not match endpoint', {});
    const payload = payloadSchema.parse(envelope.payload);
    let value: unknown;
    switch (endpoint) {
      case 'session/create': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        if ((input.cwd && input.cwd !== '/workspace') || (input.workspaceId && input.workspaceId !== 'default')) {
          throw new RemoteError('gateway/method-unavailable', 'Native workspace catalog is not connected yet', {endpoint});
        }
        if (input.cwd && input.workspaceId) throw new RemoteError('gateway/bad-request', 'workspaceId and cwd are exclusive', {});
        let sessionId = input.sessionId ?? SessionId(crypto.randomUUID());
        let target = session(sessionId);
        const existing = await target.stub.nativeStatus(target.scope);
        if (existing && (!existing.blank || existing.running)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
        }
        const binding = input.agentPreset ? {id: input.agentPreset} : undefined;
        if (!await target.stub.nativeCreate(target.scope, binding, input.workspaceId)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
          if (!await target.stub.nativeCreate(target.scope, binding, input.workspaceId)) throw new RemoteError('gateway/internal', 'New Session identity was already used', {});
        }
        const header = await target.stub.nativeHeader(target.scope);
        value = {sessionId, ...(header?.agentPreset ? {agentPreset: header.agentPreset} : {})};
        break;
      }
      case 'session/list': {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const records = await control.sessionIndex(owner);
        const items = await Promise.all(records.map(async record => {
          const target = session(record.id);
          const status = await target.stub.nativeStatus(target.scope);
          if (!status) return undefined;
          const raw: unknown = await (await target.stub.nativeProjections(target.scope)).json();
          const projections = sessionRemote.methods['session/projections'].result.create().parse(raw);
          return {...status, ...(projections?.kind === 'sequenced' ? {projections: {kind: 'sequenced' as const, asOfSeq: projections.asOfSeq, values: projections.values}} : {})};
        }));
        value = {items: items.filter(item => item !== undefined)};
        break;
      }
      case 'session/page': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        if (input.address.kind !== 'session') throw new RemoteError('gateway/method-unavailable', 'Subagent history is not connected yet', {endpoint});
        const target = session(input.address.sessionId);
        value = await (await target.stub.nativePage(target.scope, input)).json();
        break;
      }
      case 'session/projections': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        value = await (await target.stub.nativeProjections(target.scope)).json();
        break;
      }
      case 'session/rename': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        if (!await target.stub.nativeStatus(target.scope)) notFound(input.sessionId);
        value = await target.stub.nativeRename(target.scope, input.title);
        break;
      }
      case 'session/prompt': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        await target.stub.nativePrompt(target.scope, input);
        value = {accepted: true};
        break;
      }
      case 'session/cancel': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        if (!await target.stub.nativeStatus(target.scope)) notFound(input.sessionId);
        await target.stub.nativeCancel(target.scope);
        value = {accepted: true};
        break;
      }
      default: throw new RemoteError('gateway/method-unavailable', 'Remote method is not connected yet', {endpoint});
    }
    let checked: unknown;
    try { checked = sessionRemote.methods[endpoint as Endpoint].result.create().parse(value); }
    catch { throw new RemoteError('gateway/result-invalid', 'Host result does not match the pinned Remote contract', {endpoint}); }
    return Response.json({type: 'server-response', rpcId, result: {ok: true, value: checked}}, {headers: {'cache-control': 'private, no-store'}});
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const failure = remoteErrorOf(error) ?? (error instanceof z.ZodError
      ? {code: 'gateway/bad-request', message: 'Invalid Remote arguments', details: {}}
      : {code: 'gateway/internal', message: 'Host operation failed', details: {}});
    return Response.json({type: 'server-response', rpcId, result: {ok: false, error: {code: failure.code, message: failure.message, details: failure.details}}}, {headers: {'cache-control': 'private, no-store'}});
  }
}
