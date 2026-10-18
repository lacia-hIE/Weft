import { z } from 'zod';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@weft/upstream/packages/api/gateway/src/remote-error-codes.ts';
import { clientRequestSchema } from '@weft/upstream/packages/client/connection/src/rpc-schema.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import workspaceRemote from '../../../.generated/official-remotes/packages/api/workspace-controller/typert.remote-client.js';
import llmRemote from '../../../.generated/official-remotes/packages/llm/llm/typert.remote-client.js';
import pluginRemote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import type { NativePluginEndpoint } from '../../../packages/native-plugins/src/host.ts';
import { MODEL_NAMESPACE } from '../../../packages/control-plane/src/native-settings.ts';
import { controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';
import { sessionAddress, scopeSchema, type Principal } from '../../../packages/tenant/src/index.ts';
import type { Env } from './index.ts';
import { assertSameOrigin, HttpError, readJson } from './http.ts';
import { resolveTenantModel, ModelConfigurationError, readEnvironmentModelConfiguration } from '../../../packages/model-provider/src/index.ts';

const payloadSchema = z.object({args: z.unknown()}).strict();
type Endpoint = keyof typeof sessionRemote.methods;

/** Official Connection envelopes and generated codecs at the CF host boundary. */
export async function handleNativeRequest(request: Request, env: Env, principal: Principal, environmentId?: string): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  const auxiliary = /^\/v1\/tenants\/([^/]+)\/native\/(open-in-app\/apps|plugins\/boot)$/.exec(pathname);
  if (auxiliary) {
    if (auxiliary[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    if (request.method !== 'GET') throw new HttpError(405, 'Expected GET');
    if (auxiliary[2] === 'open-in-app/apps') return Response.json({apps: []}, {headers: {'cache-control': 'private, no-store'}});
    return env.UI.fetch(new Request(new URL('/harness/boot.json', request.url)));
  }
  const match = /^\/v1\/tenants\/([^/]+)\/native\/(api|streams)\/(.+)$/.exec(pathname);
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
      if (endpoint === '$events') {
        z.object({args: z.object({}).strict()}).strict().parse(raw);
        return await control.fetch(new Request('https://environment.internal/native-events', {method: 'POST', body: JSON.stringify({operation: 'native-events', scope: owner}), signal: request.signal}));
      }
      if (endpoint === 'workspace/follow') {
        workspaceRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        return await control.fetch(new Request('https://environment.internal/native-workspaces', {method: 'POST', body: JSON.stringify({operation: 'native-workspaces', scope: owner}), signal: request.signal}));
      }
      if (endpoint === 'session/control') {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        return await control.fetch(new Request('https://environment.internal/native-control', {method: 'POST', body: JSON.stringify({operation: 'native-session-control', scope: owner}), signal: request.signal}));
      }
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
    if (endpoint.startsWith('dynamicCordisRunner/')) {
      if (!Object.hasOwn(pluginRemote.methods, endpoint)) throw new RemoteError('gateway/method-unavailable', 'Unknown plugin method', {endpoint});
      const method = pluginRemote.methods[endpoint as NativePluginEndpoint];
      const args = method.input({strict: true}).create().parse(payload.args) as Record<string, unknown>;
      let value: unknown;
      if (endpoint === 'dynamicCordisRunner/inventory') value = (await (await control.nativePluginInventory(owner)).json() as {value: unknown}).value;
      else if (endpoint === 'dynamicCordisRunner/syncInspectManifest') {
        const sessions = await control.nativeSetPluginManifest(owner, args.providers);
        await Promise.all(sessions.map(id => {const target = session(id); return target.stub.nativePluginManifest(target.scope, args.providers);}));
        value = null;
      } else {
        const sessionId = typeof args.agentId === 'string' ? args.agentId
          : await control.nativePluginOwner(owner, endpoint === 'dynamicCordisRunner/resolveRequestRun' ? 'approval' : endpoint === 'dynamicCordisRunner/resolveInspectQuery' ? 'inspect' : 'plugin', String(args.requestId ?? args.pluginId));
        if (!sessionId) {
          if (endpoint === 'dynamicCordisRunner/resolveRequestRun' || endpoint === 'dynamicCordisRunner/resolveInspectQuery') value = {accepted: false};
          else throw new RemoteError('gateway/bad-request', 'Plugin is not in this environment', {});
        } else {
          const target = session(sessionId);
          value = (await (await target.stub.nativePluginCall(target.scope, endpoint as NativePluginEndpoint, args)).json() as {value: unknown}).value;
        }
      }
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(value)}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint.startsWith('settings/') || endpoint.startsWith('credentials/')) {
      const {value} = await (await control.nativeSettingsRequest(owner, endpoint, payload.args)).json() as {value?: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === 'llm/listProviders' || endpoint === 'llm/listConfigurableProviders') {
      const method = llmRemote.methods[endpoint];
      method.input({strict: true}).create().parse(payload.args);
      const value = method.result.create().parse(endpoint === 'llm/listConfigurableProviders'
        ? [{provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: MODEL_NAMESPACE, settingsPath: []}]
        : env.MODEL_BACKEND === 'scripted' ? [{id: 'validation', name: 'validation'}] : [{id: 'deepseek-official', name: 'DeepSeek'}]);
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint.startsWith('workspace/') || endpoint.startsWith('directoryPicker/')) {
      const output = await control.nativeWorkspace(owner, endpoint, payload.args);
      const {value} = await output.json() as {value?: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    let value: unknown;
    switch (endpoint) {
      case 'session/canOpenWorkspacePath': {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        value = false; break;
      }
      case 'session/workspacePathApplications': {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        value = []; break;
      }
      case 'session/modelCatalog': {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const configuration = await readEnvironmentModelConfiguration(await control.nativeModelConfiguration(owner));
        const selected = resolveTenantModel(env, principal.tenantId, await control.nativeDefaultModel(owner), configuration);
        const provider = selected.adapter.providerInfo(selected.model.provider);
        const models = await selected.adapter.listModels(selected.model.provider);
        value = {default: selected.model, routableProviders: models.length ? [provider.id] : [], groups: models.length ? [{id: provider.id, name: provider.name, models: models.map(model => ({id: model.id, name: model.name, ...(model.description ? {description: model.description} : {}), ...('reasoning' in model && model.reasoning ? {reasoning: model.reasoning} : {})}))}] : [], failures: []};
        break;
      }
      case 'session/create': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const workspace = await control.nativeResolveWorkspace(owner, input.workspaceId, input.cwd);
        let sessionId = input.sessionId ?? SessionId(crypto.randomUUID());
        let target = session(sessionId);
        const existing = await target.stub.nativeStatus(target.scope);
        if (existing && (!existing.blank || existing.running)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
        }
        const binding = input.agentPreset ? {id: input.agentPreset} : undefined;
        if (!await target.stub.nativeCreate(target.scope, binding, 'default', workspace.path)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
          if (!await target.stub.nativeCreate(target.scope, binding, 'default', workspace.path)) throw new RemoteError('gateway/internal', 'New Session identity was already used', {});
        }
        await control.nativeAttachWorkspace(owner, workspace.workspaceId, sessionId);
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
      case 'session/selectModel': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        value = await (await target.stub.nativeSelectModel(target.scope, input)).json();
        break;
      }
      case 'session/updateQueue': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(input.sessionId);
        await target.stub.nativeUpdateQueue(target.scope, input);
        value = {accepted: true}; break;
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
      : error instanceof ModelConfigurationError && error.code === 'MODEL_NOT_CONFIGURED'
      ? {code: 'session/provider-credentials-unavailable', message: error.message, details: {}}
      : {code: 'gateway/internal', message: 'Host operation failed', details: {}});
    return Response.json({type: 'server-response', rpcId, result: {ok: false, error: {code: failure.code, message: failure.message, details: failure.details}}}, {headers: {'cache-control': 'private, no-store'}});
  }
}
