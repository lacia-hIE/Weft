import type { ControlScope } from '../../../packages/control-plane/src/contracts.ts';
import { z } from 'zod';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@weft/upstream/packages/api/gateway/src/remote-error-codes.ts';
import { clientRequestSchema } from '@weft/upstream/packages/client/connection/src/rpc-schema.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import workspaceRemote from '../../../.generated/official-remotes/packages/api/workspace-controller/typert.remote-client.js';
import llmRemote from '../../../.generated/official-remotes/packages/llm/llm/typert.remote-client.js';
import pluginRemote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import presetRemote from '../../../.generated/official-remotes/packages/preset/agent-preset-registry/typert.remote-client.js';
import inventoryRemote from '../../../.generated/official-remotes/packages/host/plugin-inventory/typert.remote-client.js';
import managerRemote from '../../../.generated/official-remotes/packages/boot/plugin-manager/typert.remote-client.js';
import fileRemote from '../../../.generated/official-remotes/packages/api/workspace-files/typert.remote-client.js';
import type {NativeFileEndpoint} from '../../../packages/native-files/src/index.ts';
import {IMAGE_PROMPT_BODY_BYTES} from '../../../packages/native-attachments/src/image-policy.ts';
import uploadRemote from '../../../.generated/official-remotes/packages/client/file-upload/typert.remote-client.js';
import {agentRemoteFor} from './agent-remotes.ts';
import scheduleRemote from '../../../.generated/official-remotes/packages/schedule/schedule/typert.remote-client.js';
import {environmentRemoteFor} from '../../../packages/native-environment/src/index.ts';
import {isMarketEndpoint} from '../../../packages/native-environment/src/market.ts';
import {openPermissionWorld} from '../../../packages/native-environment/src/permissions.ts';
import permissionRemote from '../../../.generated/official-remotes/packages/interaction/permission-presets/typert.remote-client.js';
import {remoteAgentId} from '../../../packages/harness-runtime/src/remote-dispatch.ts';
import questionRemote from '../../../.generated/official-remotes/packages/interaction/user-questions/typert.remote-client.js';
import {FILE_UPLOAD_PATH} from '@weft/upstream/packages/client/file-upload/src/protocol.ts';
import {SESSION_LOG_EXPORT_PATH} from '@deepseek-ai/dsh-session-log-export';
import {CHANGED_FILES_PATH, CHANGES_DIFF_PATH, CHANGES_OPEN_PATH} from '@weft/upstream/packages/client/ui-deliverables/src/changes.ts';
import {PRESENT_HOST_PATH, PRESENT_OPEN_PATH} from '@weft/upstream/packages/client/ui-deliverables/src/presented.ts';
import type { NativePluginEndpoint } from '../../../packages/native-plugins/src/host.ts';
import { MODEL_NAMESPACE } from '../../../packages/control-plane/src/native-settings.ts';
import {mapConcurrent} from '../../../packages/native-query/src/concurrent.ts';
import {subagentRemote, type SubagentEndpoint} from '../../../packages/native-subagents/src/protocol.ts';
import { controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';
import { sessionAddress, scopeSchema, type Principal } from '../../../packages/tenant/src/index.ts';
import type { Env } from './index.ts';
import { assertSameOrigin, HttpError, readJson } from './http.ts';
import {workspaceAddress} from '../../../packages/workspace/src/protocol.ts';
import {javascriptRequest} from '../../../packages/workspace/src/javascript.ts';
declare const WEFT_VALIDATION_BUILD: boolean;

import { ModelConfigurationError } from '../../../packages/model-provider/src/index.ts';
import { isEnvironmentModelEndpoint } from '../../../packages/native-models/src/environment.ts';

const payloadSchema = z.object({args: z.unknown()}).strict();
type Endpoint = keyof typeof sessionRemote.methods;

/** Official Connection envelopes and generated codecs at the CF host boundary. */
/** Session Durable Objects one environment-wide read asks at once; each answer is a cross-object round trip. */
const SESSION_FAN_OUT = 16;

/**
 * A Session's root never changes once the environment records it (a child's
 * owner is immutable and a root owns itself), so this isolate keeps found
 * roots instead of asking the environment before every Session call. Unknown
 * Sessions are asked again: they may be created later.
 */
const roots = new Map<string, {root: string; at: number}>();
const ROOT_MS = 600_000;
async function cachedRoot(owner: ControlScope, control: ReturnType<typeof controlFor>, sessionId: string): Promise<string | undefined> {
  const key = JSON.stringify([owner.tenantId, owner.environmentId, sessionId]);
  const cached = roots.get(key);
  if (cached && Date.now() - cached.at < ROOT_MS) return cached.root;
  const root = await control.nativeSessionRoot(owner, sessionId);
  if (root !== undefined) {
    if (roots.size >= 4096) roots.clear();
    roots.set(key, {root, at: Date.now()});
  }
  return root;
}

export async function handleNativeRequest(request: Request, env: Env, principal: Principal, environmentId?: string): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  const javascript = /^\/v1\/tenants\/([^/]+)\/native\/javascript-tasks$/.exec(pathname);
  if (javascript) {
    if (javascript[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, {status: 405, headers: {allow: 'GET, POST'}});
    const headers = {'cache-control': 'private, no-store'};
    if (request.method === 'POST') assertSameOrigin(request);
    const url = new URL(request.url);
    const input = z.object({sessionId: z.string().min(1).max(80), operation: z.enum(['list', 'status', 'cancel', 'cancelAll']), id: z.uuid().optional()}).strict().safeParse(request.method === 'GET'
      ? {sessionId: url.searchParams.get('sessionId'), operation: url.searchParams.has('id') ? 'status' : 'list', ...(url.searchParams.has('id') ? {id: url.searchParams.get('id')} : {})}
      : await readJson(request, 4096));
    if (!input.success || (request.method === 'POST' && !['cancel', 'cancelAll'].includes(input.data.operation))) return Response.json({error: 'Invalid task request'}, {status: 400, headers});
    const owner = controlScope(principal.tenantId, environmentId), control = controlFor(env, owner);
    const root = await cachedRoot(owner, control, input.data.sessionId);
    if (!root) return Response.json({error: 'Session not found'}, {status: 404, headers});
    const operation = javascriptRequest.safeParse({operation: input.data.operation, ...(input.data.id ? {id: input.data.id} : {})});
    if (!operation.success) return Response.json({error: 'Invalid task operation'}, {status: 400, headers});
    const scope = {...owner, workspaceId: 'default'};
    try {
      const response = await env.WORKSPACES.getByName(workspaceAddress(scope)).javascript(scope, input.data.sessionId, operation.data);
      return new Response(response.body, {status: response.status, headers: {...headers, 'content-type': 'application/json'}});
    } catch {return Response.json({error: 'Task is unavailable in this Session'}, {status: 404, headers});}
  }
  const packages = /^\/v1\/tenants\/([^/]+)\/native\/(package-installations|package-assets\/([a-f0-9]{64})\/(client\.(?:js|css)|assets\/[A-Za-z0-9_-]+\.[a-z0-9]+))$/.exec(pathname);
  if (packages) {
    if (packages[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    const owner = controlScope(principal.tenantId, environmentId), control = controlFor(env, owner);
    try {
      if (packages[2]?.startsWith('package-assets/')) {
        if (!['GET','HEAD'].includes(request.method)) return new Response(null, {status: 405});
        const name = new URL(request.url).searchParams.get('name');
        if (name && name.length > 214) throw new HttpError(400, 'Invalid package name');
        const response = await control.nativePackageResource(owner, packages[3]!, packages[4]!, name ?? undefined);
        if (request.method === 'HEAD') {await response.body?.cancel(); return new Response(null,{status:response.status,headers:response.headers});}
        return response;
      }
      if (request.method === 'GET' && packages[2] === 'package-installations') return control.nativePackageList(owner);
      if (request.method !== 'POST') return new Response(null, {status: 405});
      assertSameOrigin(request);
      const raw = await readJson(request, 1024 * 1024);
      if (packages[2] === 'package-installations') return await control.nativePackageOperation(owner, raw);
      throw new HttpError(405, 'Unsupported bundle operation');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 409, headers: {'cache-control': 'private, no-store'}});
    }
  }
  const container = /^\/v1\/tenants\/([^/]+)\/native\/workspace-container$/.exec(pathname);
  if (container) {
    if (container[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, {status: 405, headers: {allow: 'GET, POST'}});
    const scope = {tenantId: principal.tenantId, environmentId: environmentId ?? 'default', workspaceId: 'default'};
    const stub = env.WORKSPACES.getByName(workspaceAddress(scope));
    if (request.method === 'GET') return Response.json(await stub.containerState(scope), {headers: {'cache-control': 'private, no-store'}});
    assertSameOrigin(request);
    if (!z.object({}).strict().safeParse(await readJson(request, 4096)).success) throw new HttpError(400, 'Expected an empty container stop request');
    const owner = controlScope(principal.tenantId, environmentId);
    const sessions = (await controlFor(env, owner).sessionIndex(owner)).filter(record => record.workspaceId === scope.workspaceId).map(record => record.id);
    return stub.stopContainer(scope, sessions);
  }
  const sessionExport = /^\/v1\/tenants\/([^/]+)\/native\/api\/session\.export$/.exec(pathname);
  if (sessionExport) {
    if (sessionExport[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    const headers = {'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'};
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, {status: 405, headers: {...headers, allow: 'GET, HEAD'}});
    const url = new URL(request.url);
    const parsed = scopeSchema.safeParse({tenantId: principal.tenantId, sessionId: url.searchParams.get('sessionId'), ...(environmentId ? {environmentId} : {})});
    const descendants = url.searchParams.get('includeDescendants');
    if (!parsed.success || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('includeDescendants').length > 1 || (descendants !== null && descendants !== 'true' && descendants !== 'false')) return new Response(request.method === 'HEAD' ? null : 'Invalid export query', {status: 400, headers});
    const owner = controlScope(principal.tenantId, environmentId);
    const root = await cachedRoot(owner, controlFor(env, owner), parsed.data.sessionId);
    if (!root) return new Response(request.method === 'HEAD' ? null : 'Session not found', {status: 404, headers});
    const scope = {...parsed.data, sessionId: root};
    url.pathname = SESSION_LOG_EXPORT_PATH;
    const response = await env.SESSIONS.getByName(sessionAddress(scope)).fetch(new Request(url, {
      method: request.method, headers: {'x-weft-session-scope': JSON.stringify(scope)}, signal: request.signal,
    }));
    const responseHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
    return new Response(response.body, {status: response.status, headers: responseHeaders});
  }
  const upload = /^\/v1\/tenants\/([^/]+)\/native\/api\/session\/uploadFileBinary$/.exec(pathname);
  if (upload) {
    if (upload[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    assertSameOrigin(request);
    if (request.method !== 'POST') return new Response(null, {status: 405, headers: {allow: 'POST'}});
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') return new Response('content type must be application/octet-stream', {status: 415});
    const url = new URL(request.url);
    const parsed = scopeSchema.safeParse({tenantId: principal.tenantId, sessionId: url.searchParams.get('sessionId'), ...(environmentId ? {environmentId} : {})});
    if (!parsed.success) return new Response('valid sessionId is required', {status: 400});
    const scope = parsed.data;
    url.pathname = FILE_UPLOAD_PATH;
    try {
      return await env.SESSIONS.getByName(sessionAddress(scope)).fetch(new Request(url, {method: 'POST', headers: {'content-type': 'application/octet-stream', 'x-weft-session-scope': JSON.stringify(scope)}, body: request.body, signal: request.signal}));
    } catch (error) {
      const failure = remoteErrorOf(error) ?? {code: 'gateway/internal', message: 'File upload failed', details: {}};
      return Response.json({ok: false, error: {code: failure.code, message: failure.message, details: failure.details}}, {headers: {'cache-control': 'no-store'}});
    }
  }
  const deliverables = /^\/v1\/tenants\/([^/]+)\/native(\/api\/(?:changes\.(?:summary|diff|open)|present\.(?:host|open)))$/.exec(pathname);
  if (deliverables) {
    if (deliverables[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    const route = deliverables[2]!;
    const headers = {'cache-control': 'no-store'};
    // A Weft deployment has no Host desktop: the deliverables client hides native opens, as on a headless Host.
    if (route === PRESENT_HOST_PATH) return request.method === 'GET' ? Response.json({name: 'Cloudflare', available: false, fileManager: null}, {headers}) : new Response(null, {status: 405, headers: {allow: 'GET'}});
    if (route === PRESENT_OPEN_PATH || route === CHANGES_OPEN_PATH) return new Response('Host desktop unavailable.', {status: 409, headers});
    if (request.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET'}});
    const url = new URL(request.url);
    const parsed = scopeSchema.safeParse({tenantId: principal.tenantId, sessionId: url.searchParams.get('sessionId'), ...(environmentId ? {environmentId} : {})});
    if (!parsed.success) return new Response('valid sessionId is required', {status: 400, headers});
    // Summaries and comparisons are served by the Session's live change recorder.
    url.pathname = route === CHANGED_FILES_PATH ? CHANGED_FILES_PATH : CHANGES_DIFF_PATH;
    return env.SESSIONS.getByName(sessionAddress(parsed.data)).fetch(new Request(url, {headers: {'x-weft-session-scope': JSON.stringify(parsed.data)}, signal: request.signal}));
  }
  const observerCancel = /^\/v1\/tenants\/([^/]+)\/native\/file-observers\/cancel$/.exec(pathname);
  if (observerCancel) {
    if (observerCancel[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    if (request.method !== 'POST') throw new HttpError(405, 'Expected POST');
    assertSameOrigin(request);
    const input = z.object({sessionId: z.string(), observerId: z.uuid()}).strict().safeParse(await readJson(request, 4096));
    if (!input.success) throw new HttpError(400, 'Invalid file observer cancellation');
    const parsed = scopeSchema.safeParse({tenantId: principal.tenantId, sessionId: input.data.sessionId, ...(environmentId ? {environmentId} : {})});
    if (!parsed.success) throw new HttpError(400, 'Invalid file observer scope');
    const scope = parsed.data;
    await env.SESSIONS.getByName(sessionAddress(scope)).nativeCancelFileObserver(scope, input.data.observerId);
    return new Response(null, {status: 204, headers: {'cache-control': 'private, no-store'}});
  }
  const auxiliary = /^\/v1\/tenants\/([^/]+)\/native\/(open-in-app\/apps|plugins\/boot)$/.exec(pathname);
  if (auxiliary) {
    if (auxiliary[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
    if (request.method !== 'GET') throw new HttpError(405, 'Expected GET');
    if (auxiliary[2] === 'open-in-app/apps') return Response.json({apps: []}, {headers: {'cache-control': 'private, no-store'}});
    const asset = await env.UI.fetch(new Request(new URL('/harness/boot.json', request.url)));
    if (!asset.ok) return asset;
    const graph = await asset.json() as {rev: string; entries: {id: string}[]; batches: {entries: string[]}[]};
    const teamClient = '@deepseek-ai/dsh-experimental-client-ui-agent-team';
    const owner = controlScope(principal.tenantId, environmentId);
    const clients = await controlFor(env, owner).nativeOfficialBundleClients(owner);
    if (!clients.includes(teamClient)) {
      graph.entries = graph.entries.filter(row => row.id !== teamClient);
      graph.batches = graph.batches.filter(row => !row.entries.includes(teamClient));
      graph.rev += '-without-teams';
    }
    return Response.json(graph, {headers: {'cache-control': 'private, no-store'}});
  }
  const match = /^\/v1\/tenants\/([^/]+)\/native\/(api|streams)\/(.+)$/.exec(pathname);
  if (!match) return undefined;
  if (match[1] !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
  if (request.method !== 'POST') throw new HttpError(405, 'Expected POST');
  assertSameOrigin(request);
  const owner = controlScope(principal.tenantId, environmentId);
  const control = controlFor(env, owner);
  const sessionRoot = (sessionId: string) => cachedRoot(owner, control, sessionId);
  const endpoint = match[3]!;
  let rpcId = 'invalid-request';
  const session = (sessionId: string) => {
    const scope = scopeSchema.parse({tenantId: principal.tenantId, sessionId, ...(environmentId ? {environmentId} : {})});
    return {scope, stub: env.SESSIONS.getByName(sessionAddress(scope))};
  };
  const notFound = (sessionId: string): never => { throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(sessionId)}); };
  const parentSession = async (parentId: string, childId = parentId) => {
    session(parentId);
    const root = await sessionRoot(parentId);
    if (!root) throw new RemoteError('subagent/not-found', 'Subagent parent is not available', {parentSessionId: SessionId(parentId), childSessionId: SessionId(childId)});
    return session(root);
  };
  try {
    const raw = await readJson(request, endpoint === 'session/prompt' || endpoint === 'subagents/prompt' ? IMAGE_PROMPT_BODY_BYTES : endpoint === 'fileUploads/upload' ? 8 * 1024 * 1024 : 65_536);
    if (match[2] === 'streams') {
      if (endpoint === 'workspaceFiles/changes') {
        const observerId = z.uuid().parse(request.headers.get('x-weft-observer-id'));
        const args = fileRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        const target = session(args.workspaceFileScopeId);
        return await target.stub.fetch(new Request('https://session.internal/native-file-changes', {
          method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-file-changes', observerId, args}), signal: request.signal,
        }));
      }
      if (endpoint === '$events') {
        z.object({args: z.object({}).strict()}).strict().parse(raw);
        return await control.fetch(new Request('https://environment.internal/native-events', {method: 'POST', body: JSON.stringify({operation: 'native-events', scope: owner}), signal: request.signal}));
      }
      if (endpoint === 'workspace/follow') {
        workspaceRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        return await control.fetch(new Request('https://environment.internal/native-workspaces', {method: 'POST', body: JSON.stringify({operation: 'native-workspaces', scope: owner}), signal: request.signal}));
      }
      if (environmentRemoteFor(endpoint)) {
        return await control.fetch(new Request('https://environment.internal/native-environment-stream', {
          method: 'POST', body: JSON.stringify({operation: 'native-environment-stream', scope: owner, endpoint, args: payloadSchema.parse(raw).args}), signal: request.signal,
        }));
      }
      const streamRemote = agentRemoteFor(endpoint);
      if (streamRemote && endpoint !== 'userQuestions/attachWait') {
        const args = payloadSchema.parse(raw).args;
        const target = session(await sessionRoot(remoteAgentId(streamRemote, endpoint, args)) ?? remoteAgentId(streamRemote, endpoint, args));
        const streamId = request.headers.get('x-weft-stream-id') ?? undefined;
        return await target.stub.fetch(new Request('https://session.internal/native-agent-stream', {
          method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-agent-stream', endpoint, args, ...(streamId ? {streamId: z.uuid().parse(streamId)} : {})}), signal: request.signal,
        }));
      }
      if (endpoint === 'userQuestions/attachWait') {
        const args = questionRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        const target = session(await sessionRoot(args.agentId) ?? args.agentId);
        return await target.stub.fetch(new Request('https://session.internal/native-question-wait', {
          method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-question-wait', args}), signal: request.signal,
        }));
      }
      if (endpoint === 'session/control') {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payloadSchema.parse(raw).args);
        return await control.fetch(new Request('https://environment.internal/native-control', {method: 'POST', body: JSON.stringify({operation: 'native-session-control', scope: owner}), signal: request.signal}));
      }
      if (endpoint !== 'session/follow') throw new RemoteError('gateway/method-unavailable', 'Remote stream is not connected yet', {endpoint});
      const payload = payloadSchema.parse(raw);
      const args = sessionRemote.methods['session/follow'].input({strict: true}).create().parse(payload.args);
      const target = args.request.address.kind === 'session' ? session(args.request.address.sessionId) : await parentSession(args.request.address.parentSessionId);
      return await target.stub.fetch(new Request('https://session.internal/native-follow', {
        method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-follow', args}), signal: request.signal,
      }));
    }
    const envelope = clientRequestSchema.parse(raw);
    rpcId = envelope.rpcId;
    if (envelope.method !== endpoint) throw new RemoteError('gateway/bad-request', 'RPC method does not match endpoint', {});
    const payload = payloadSchema.parse(envelope.payload);
    if (Object.hasOwn(subagentRemote.methods, endpoint)) {
      const method = subagentRemote.methods[endpoint as SubagentEndpoint];
      const args = method.input({strict: true}).create().parse(payload.args);
      const parentId = 'request' in args ? args.request.parentSessionId : args.parentSessionId;
      const target = await parentSession(parentId);
      const response = await target.stub.fetch(new Request('https://session.internal/native-subagent', {
        method: 'POST', body: JSON.stringify({scope: target.scope, operation: 'native-subagent', endpoint, args}), signal: request.signal,
      }));
      const result = await response.json() as {ok: boolean; value?: unknown; error?: unknown};
      if (!result.ok) {
        const failure = remoteErrorOf(result.error);
        if (failure) throw new RemoteError(failure.code, failure.message, failure.details);
        throw new RemoteError('gateway/internal', 'Invalid subagent response', {});
      }
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(result.value)}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === 'permissionPresets/catalog') {
      const method = permissionRemote.methods[endpoint];
      method.input({strict: true}).create().parse(payload.args);
      const world = await openPermissionWorld(await control.nativePermissionDefault(owner));
      try {
        return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(world.catalog())}}, {headers: {'cache-control': 'private, no-store'}});
      } finally { await world.ctx.fiber.dispose(); }
    }
    if (endpoint === '$stream/input') {
      // Ordered client uplink for one open bidirectional stream, delivered to the object that opened it.
      const input = z.object({streamId: z.uuid(), endpoint: z.string().max(200), args: z.unknown(), items: z.array(z.unknown()).max(64), end: z.boolean()}).strict().parse(payload.args);
      const remote = agentRemoteFor(input.endpoint);
      if (!remote) throw new RemoteError('gateway/method-unavailable', 'Remote stream is not connected yet', {endpoint: input.endpoint});
      const agentId = remoteAgentId(remote, input.endpoint, input.args);
      const target = session(await sessionRoot(agentId) ?? agentId);
      await target.stub.nativeStreamInput(target.scope, input.streamId, input.items, input.end);
      return Response.json({type: 'server-response', rpcId, result: {ok: true}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === '$events/result') {
      await control.nativeEventResult(owner, payload.args);
      return Response.json({type: 'server-response', rpcId, result: {ok: true}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === 'schedule/catalog') {
      const method = scheduleRemote.methods[endpoint];
      method.input({strict: true}).create().parse(payload.args);
      const records = await control.sessionIndex(owner);
      const groups = await mapConcurrent(records, async record => {const target = session(record.id); return target.stub.nativeScheduleCatalog(target.scope);}, request.signal, SESSION_FAN_OUT);
      const value = method.result.create().parse(groups.flat().sort((a, b) => {
        const left = a as {scheduledAt: string; id: string}, right = b as {scheduledAt: string; id: string};
        return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id);
      }));
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    const agentRemote = agentRemoteFor(endpoint);
    if (agentRemote) {
      const target = session(await sessionRoot(remoteAgentId(agentRemote, endpoint, payload.args)) ?? remoteAgentId(agentRemote, endpoint, payload.args));
      const result = await (await target.stub.nativeAgentRemote(target.scope, endpoint, payload.args)).json() as {ok: boolean; value?: unknown; error?: unknown};
      if (!result.ok) {
        const failure = remoteErrorOf(result.error);
        throw failure ? new RemoteError(failure.code, failure.message, failure.details) : new RemoteError('gateway/internal', 'Invalid Agent Remote response', {});
      }
      return Response.json({type: 'server-response', rpcId, result: {ok: true, ...('value' in result ? {value: result.value} : {})}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === 'fileUploads/upload') {
      const method = uploadRemote.methods[endpoint];
      const args = method.input({strict: true}).create().parse(payload.args);
      const target = session(args.agentId);
      const {value} = await (await target.stub.nativeFileUpload(target.scope, args)).json() as {value: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(value)}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint.startsWith('workspaceFiles/')) {
      if (endpoint === 'workspaceFiles/changes' || !Object.hasOwn(fileRemote.methods, endpoint)) {
        throw new RemoteError('gateway/method-unavailable', 'Unknown file method', {endpoint});
      }
      const method = fileRemote.methods[endpoint as NativeFileEndpoint];
      const args = method.input({strict: true}).create().parse(payload.args);
      const target = session(args.workspaceFileScopeId);
      return await target.stub.nativeFileCall(target.scope, endpoint as NativeFileEndpoint, args, rpcId);
    }
    if (endpoint === 'agentPresets/list' || endpoint === 'agentPresets/read' || endpoint === 'pluginInventory/list' || endpoint === 'pluginManager/listPlugins' || endpoint === 'pluginManager/listBundles') {
      const method = {...presetRemote.methods, ...inventoryRemote.methods, ...managerRemote.methods}[endpoint];
      const args = method.input({strict: true}).create().parse(payload.args);
      const {value} = await (await control.nativePreset(owner, endpoint, args)).json() as {value: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(value)}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (isMarketEndpoint(endpoint)) {
      const {value} = await (await control.nativePluginMarket(owner, endpoint, payload.args)).json() as {value: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint.startsWith('pluginManager/')) {
      const {value} = await (await control.nativeManagePlugins(owner, endpoint, payload.args)).json() as {value: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint === 'agentPresets/select') {
      const method = presetRemote.methods[endpoint];
      const args = method.input({strict: true}).create().parse(payload.args);
      const target = session(args.agentId);
      const value = await target.stub.nativeSelectPreset(target.scope, args.agentPreset);
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value: method.result.create().parse(value)}}, {headers: {'cache-control': 'private, no-store'}});
    }
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
    if (isEnvironmentModelEndpoint(endpoint)) {
      const {value} = await (await control.nativeModelRemote(owner, endpoint, payload.args)).json() as {value: unknown};
      return Response.json({type: 'server-response', rpcId, result: {ok: true, value}}, {headers: {'cache-control': 'private, no-store'}});
    }
    if (endpoint.startsWith('workspace/') || endpoint.startsWith('directoryPicker/')) {
      const output = await control.nativeWorkspace(owner, endpoint, payload.args);
      const {value, error} = await output.json() as {value?: unknown; error?: unknown};
      const failure = remoteErrorOf(error);
      if (failure) throw new RemoteError(failure.code, failure.message, failure.details);
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
      case 'session/create': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        let sessionId = input.sessionId ?? SessionId(crypto.randomUUID());
        let target = session(sessionId);
        const [workspace, existingOwner] = await Promise.all([control.nativeResolveWorkspace(owner, input.workspaceId, input.cwd), sessionRoot(sessionId)]);
        if (existingOwner && existingOwner !== sessionId) {sessionId = SessionId(crypto.randomUUID()); target = session(sessionId);}
        const existing = await target.stub.nativeStatus(target.scope);
        if (existing && (!existing.blank || existing.running)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
        }
        const binding = input.agentPreset === undefined ? undefined : {id: input.agentPreset};
        if (!await target.stub.nativeCreate(target.scope, binding, 'default', workspace.path)) {
          sessionId = SessionId(crypto.randomUUID());
          target = session(sessionId);
          if (!await target.stub.nativeCreate(target.scope, binding, 'default', workspace.path)) throw new RemoteError('gateway/internal', 'New Session identity was already used', {});
        }
        const [, raw] = await Promise.all([control.nativeAttachWorkspace(owner, workspace.workspaceId, sessionId), target.stub.nativeProjections(target.scope).then(response => response.json())]);
        const projections = sessionRemote.methods['session/projections'].result.create().parse(raw);
        const selected = projections?.kind === 'sequenced' ? projections.values.agentPreset : undefined;
        value = {sessionId, ...(typeof selected === 'string' ? {agentPreset: selected} : {})};
        break;
      }
      case 'session/fork': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const source = session(await sessionRoot(input.sessionId) ?? notFound(input.sessionId));
        const sessionId = SessionId(crypto.randomUUID());
        const target = session(sessionId);
        const seeded = await (await source.stub.nativeForkSeed(source.scope, input.sessionId, input.atSeq)).json() as {ok: boolean; value?: Parameters<typeof target.stub.nativeCreateFork>[1]; error?: unknown};
        if (!seeded.ok || !seeded.value) {
          const failure = remoteErrorOf(seeded.error);
          throw failure ? new RemoteError(failure.code, failure.message, failure.details) : new RemoteError('gateway/internal', 'Invalid fork seed response', {});
        }
        await target.stub.nativeCreateFork(target.scope, {...seeded.value, parentSession: input.sessionId});
        const workspace = await control.nativeWorkspaceOf(owner, await sessionRoot(input.sessionId) ?? input.sessionId);
        if (workspace) await control.nativeAttachWorkspace(owner, workspace, sessionId);
        value = {sessionId};
        break;
      }
      case 'session/list': {
        sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        value = sessionRemote.methods[endpoint].result.create().parse(await (await control.fetch(new Request('https://environment.internal/native-list', {method: 'POST', body: JSON.stringify({operation: 'native-session-list', scope: owner}), signal: request.signal}))).json());
        break;
      }
      case 'session/search': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const response = await control.fetch(new Request('https://environment.internal/native-search', {
          method: 'POST', body: JSON.stringify({operation: 'native-session-search', scope: owner, query: input.query}), signal: request.signal,
        }));
        const result = await response.json() as {ok: boolean; value?: unknown; error?: unknown};
        if (!result.ok) {
          const failure = remoteErrorOf(result.error);
          if (failure) throw new RemoteError(failure.code, failure.message, failure.details);
          throw new RemoteError('gateway/internal', 'Invalid session search response', {});
        }
        value = sessionRemote.methods[endpoint].result.create().parse(result.value);
        break;
      }
      case 'session/page': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = input.address.kind === 'session' ? session(input.address.sessionId) : await parentSession(input.address.parentSessionId);
        value = await (await target.stub.nativePage(target.scope, input)).json();
        break;
      }
      case 'session/projections': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(await sessionRoot(input.sessionId) ?? input.sessionId);
        value = await (await target.stub.nativeProjections(target.scope, input.sessionId)).json();
        break;
      }
      case 'session/attachment': {
        const {request: input} = sessionRemote.methods[endpoint].input({strict: true}).create().parse(payload.args);
        const target = session(await sessionRoot(input.sessionId) ?? input.sessionId);
        const response = await target.stub.nativeImageAttachment(target.scope, input.attachmentId, input.sessionId);
        value = (await response.json() as {value: unknown}).value;
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
    if (failure.code === 'gateway/internal' && failure.message === 'Host operation failed') {
      console.error('weft.native.operation.failed', {endpoint, rpcId,
        error: error instanceof Error ? {name: error.name, message: error.message.slice(0, 2048), stack: error.stack?.slice(0, 8192)} : {name: typeof error},
      });
    }
    return Response.json({type: 'server-response', rpcId, result: {ok: false, error: {code: failure.code, message: failure.message, details: failure.details}}}, {headers: {'cache-control': 'private, no-store'}});
  }
}
