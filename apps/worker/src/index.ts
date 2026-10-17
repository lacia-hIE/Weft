import { DurableObject } from 'cloudflare:workers';
import { createSessionReader } from '../../../packages/harness-runtime/src/session-reader.ts';
import { sessionRuntime } from './runtime-options.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import { remoteStream } from '../../../packages/harness-runtime/src/remote-stream.ts';
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import { HttpError, readJson, assertSameOrigin } from './http.ts';
import { handleWorkspaceRequest } from './workspace-http.ts';
import { resolveEnvironmentRequest } from "./environment-http.ts";
import { handleControlRequest } from './control-http.ts';
import { handleNativeRequest } from './native-http.ts';
import { TenantDO, EnvironmentDO, controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';
import type { AgentRevision } from '../../../packages/control-plane/src/contracts.ts';
import { id } from '../../../packages/control-plane/src/contracts.ts';
import upstream from '../../../upstream.lock.json';
import { serveUi } from './ui-http.ts';
import { WorkspaceDO } from '../../../packages/workspace/src/object.ts';
import { workspaceIdSchema, workspaceAddress } from '../../../packages/workspace/src/protocol.ts';
export { WorkspaceDO, TenantDO, EnvironmentDO };
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn, initializeHarnessSession, renameHarnessSession, renameLiveHarnessSession } from '../../../packages/harness-runtime/src/runtime.ts';
import { turnFailure, type ModelEnvironment, type TurnFailure } from '../../../packages/model-provider/src/index.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { initializeSessionStorage, SqliteSessionPersistence, readSessionSnapshot } from '../../../packages/session-persistence-do/src/index.ts';
import { authenticateAccess, sessionAddress, scopeSchema, type SessionScope } from '../../../packages/tenant/src/index.ts';

export interface Env extends ModelEnvironment {
  UI: Fetcher;
  SESSIONS: DurableObjectNamespace<SessionDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  TENANTS: DurableObjectNamespace<TenantDO>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDO>;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

const agentBindingSchema = z.object({ id, revision: z.number().int().positive().optional() }).strict();
type AgentBinding = z.infer<typeof agentBindingSchema>;
// Keep the DO RPC projection finite; the official projection map is augmented
// by every client package and contains recursively defined JSON contracts.
interface NativeSummary {
  sessionId: string; updatedAt: number; running: boolean; agentAvailable: boolean; blank: boolean;
  cwd?: string; formatStatus: 'current';
}
const messageSchema = z.object({ text: z.string().min(1).max(8000), requestId: z.uuid().optional(), workspaceId: workspaceIdSchema.optional(), agent: agentBindingSchema.optional() }).strict();
const cancelSchema = z.object({ requestId: z.uuid() }).strict();
type TurnResult = { ok: true; requestId: string; events: readonly SessionEvent[]; model: { provider: string; model: string } }
  | { ok: false; requestId: string; error: TurnFailure };

/** One tenant-qualified session. RPC methods are reachable only through trusted bindings. */
export class SessionDO extends DurableObject<Env> {
  private readerPromise: Promise<Awaited<ReturnType<typeof createSessionReader>>> | undefined;
  private getReader() { return this.readerPromise ??= createSessionReader(this.ctx.storage); }
  private tail: Promise<void> = Promise.resolve();
  private readonly requests = new Map<string, AbortController>();
  private readonly nativeAdmissions = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_session_config (id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT)');
    const columns = ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(weft_session_config)').toArray();
    if (!columns.some(column => column.name === 'agent_document')) ctx.storage.sql.exec('ALTER TABLE weft_session_config ADD COLUMN agent_document TEXT');
    if (!columns.some(column => column.name === 'presentation')) ctx.storage.sql.exec('ALTER TABLE weft_session_config ADD COLUMN presentation INTEGER NOT NULL DEFAULT 0');
  }

  private assertScope(input: SessionScope): SessionScope {
    const scope = scopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.SESSIONS.idFromName(sessionAddress(scope)))) {
      throw new Error('Session scope does not match the addressed object');
    }
    return scope;
  }

  /** Serialize turns across awaits; DO input gates alone do not serialize model I/O. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async send(input: SessionScope, text: string, persona: string, requestId: string, workspaceId?: string, agent?: AgentBinding): Promise<Response> {
    const result = await this.execute(input, text, persona, requestId, workspaceId, agent);
    if (!result.ok) return Response.json({ error: result.error.message, code: result.error.code, requestId }, { status: result.error.status });
    return Response.json({ ...input, requestId, model: result.model, events: result.events }, { headers: { 'cache-control': 'private, no-store' } });
  }

  /** Cancellation must bypass the turn queue, and always targets one exact request. */
  async cancel(input: SessionScope, requestId: string): Promise<boolean> {
    this.assertScope(input);
    const controller = this.requests.get(requestId);
    if (!controller) return false;
    controller.abort({ code: 'TURN_CANCELLED', message: 'Turn cancelled by user', status: 409 } satisfies TurnFailure);
    return true;
  }

  private async execute(
    input: SessionScope, text: string, persona: string, requestId: string,
    workspaceId: string | undefined,
    agentBinding?: AgentBinding,
    hooks: Pick<RuntimeOptions, 'onEvent' | 'onFrame'> = {},
    nativeRequest?: Pick<SessionPromptRequest, 'requestId' | 'clientTimeZone' | 'content'>,
  ): Promise<TurnResult> {
    const scope = this.assertScope(input);
    if (this.requests.has(requestId)) return { ok: false, requestId, error: { code: 'REQUEST_ACTIVE', message: 'Request is already active', status: 409 } };
    if (this.requests.size >= 32) return { ok: false, requestId, error: { code: 'SESSION_BUSY', message: 'Session queue is full', status: 429 } };
    const controller = new AbortController();
    this.requests.set(requestId, controller);
    try {
      return await this.exclusive(async (): Promise<TurnResult> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          controller.signal.throwIfAborted();
          const stored = this.ctx.storage.sql.exec<{ workspace_id: string | null; agent_document: string | null; presentation: number }>('SELECT workspace_id,agent_document,presentation FROM weft_session_config WHERE id=1').toArray()[0];
          let profile = stored?.agent_document ? JSON.parse(stored.agent_document) as AgentRevision : undefined;
          if (stored && agentBinding && (!profile || profile.spec.id !== agentBinding.id || (agentBinding.revision !== undefined && profile.revision !== agentBinding.revision))) {
            return { ok: false, requestId, error: { code: 'AGENT_MISMATCH', message: 'Session is bound to another agent revision; start a new session', status: 409 } };
          }
          if (!stored && agentBinding) {
            profile = await controlFor(this.env, controlScope(scope.tenantId, scope.environmentId)).agent(controlScope(scope.tenantId, scope.environmentId), agentBinding.id, agentBinding.revision);
            if (!profile) return { ok: false, requestId, error: { code: 'AGENT_NOT_FOUND', message: 'Agent revision not found', status: 404 } };
          }
          if (profile && profile.upstream !== upstream.commit) return { ok: false, requestId, error: { code: 'RUNTIME_REVISION_UNAVAILABLE', message: 'This agent revision belongs to another Harness runtime; publish a reviewed revision after migration', status: 409 } };
          if (workspaceId !== undefined) workspaceIdSchema.parse(workspaceId);
          if (stored && workspaceId !== undefined && workspaceId !== stored.workspace_id) {
            return { ok: false, requestId, error: { code: 'WORKSPACE_MISMATCH', message: 'Session is already bound to another workspace', status: 409 } };
          }
          const attachedWorkspace = stored ? stored.workspace_id : profile?.spec.workspaceId ?? workspaceId ?? null;
          if (profile && workspaceId !== undefined && workspaceId !== attachedWorkspace) return { ok: false, requestId, error: { code: 'WORKSPACE_MISMATCH', message: 'Workspace conflicts with the published agent', status: 409 } };
          const presentation = stored?.presentation === 1;
          const reader = presentation ? await this.getReader() : undefined;
          const runtime = sessionRuntime(this.env, this.ctx.storage, scope, profile, attachedWorkspace, persona, presentation, reader, hooks);
          if (!stored) this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document) VALUES (1,?,?)', attachedWorkspace, profile ? JSON.stringify(profile) : null);
          if (profile) await controlFor(this.env, controlScope(scope.tenantId, scope.environmentId)).trackSession(controlScope(scope.tenantId, scope.environmentId), {
            id: scope.sessionId, title: text.slice(0, 80), agentId: profile.spec.id, revision: profile.revision, workspaceId: attachedWorkspace!, updatedAt: new Date().toISOString(),
          });
          timer = setTimeout(() => { controller.abort({ code: 'TURN_TIMEOUT', message: 'Turn deadline exceeded', status: 504 } satisfies TurnFailure); }, runtime.turnTimeoutMs);
          const events = await runHarnessTurn({
            ...runtime.options,
            ...(nativeRequest ? {requestId: nativeRequest.requestId, promptContent: nativeRequest.content.flatMap(part => part.type === 'text' ? [part] : []), ...(nativeRequest.clientTimeZone !== undefined ? {clientTimeZone: nativeRequest.clientTimeZone} : {})} : {}),
            signal: controller.signal,
            cancellationCause: () => controller.signal.reason?.code === 'TURN_TIMEOUT' ? {kind: 'hook', reason: 'turn-deadline'} : {kind: 'user'},
          }, text);
          return { ok: true, requestId, events, model: runtime.options.model };
        } catch (error) {
          return { ok: false, requestId, error: controller.signal.aborted ? controller.signal.reason as TurnFailure : turnFailure(error) };
        } finally { if (timer !== undefined) clearTimeout(timer); }
      });
    } finally { this.requests.delete(requestId); }
  }

  /** Native Web creation opens a real persisted Session before its first prompt. */
  async nativeCreate(input: SessionScope, binding?: AgentBinding, workspaceId?: string): Promise<boolean> {
    const scope = this.assertScope(input);
    return this.exclusive(async () => {
      const owner = controlScope(scope.tenantId, scope.environmentId);
      const control = controlFor(this.env, owner);
      const stored = this.ctx.storage.sql.exec<{workspace_id: string | null; agent_document: string | null}>('SELECT workspace_id,agent_document FROM weft_session_config WHERE id=1').toArray()[0];
      let profile = stored?.agent_document ? JSON.parse(stored.agent_document) as AgentRevision : await control.agent(owner, binding?.id ?? 'default', binding?.revision);
      if (!profile) throw new Error('Agent preset not found');
      const snapshot = readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId));
      if (snapshot?.events.some(event => event.type === 'turn/start')) return false;
      if (stored && binding && (profile.spec.id !== binding.id || (binding.revision !== undefined && profile.revision !== binding.revision))) {
        if (snapshot?.events.some(event => event.type === 'turn/start')) throw new Error('Session preset is fixed after its first turn');
        profile = await control.agent(owner, binding.id, binding.revision);
        if (!profile) throw new Error('Agent preset not found');
      }
      if (profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      const attachedWorkspace = workspaceId ?? stored?.workspace_id ?? profile.spec.workspaceId;
      workspaceIdSchema.parse(attachedWorkspace);
      if (stored && workspaceId && stored.workspace_id !== workspaceId && snapshot?.events.some(event => event.type === 'turn/start')) throw new Error('Session workspace is fixed after its first turn');
      const reader = await this.getReader();
      const runtime = sessionRuntime(this.env, this.ctx.storage, scope, profile, attachedWorkspace, profile.spec.persona, true, reader);
      if (snapshot) this.ctx.storage.sql.exec('UPDATE harness_sessions SET header_json=? WHERE id=?', JSON.stringify({...snapshot.header, cwd: '/workspace', agentPreset: profile.spec.id}), scope.sessionId);
      await initializeHarnessSession(runtime.options);
      this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document,presentation) VALUES (1,?,?,1) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,agent_document=excluded.agent_document,presentation=1', attachedWorkspace, JSON.stringify(profile));
      await control.trackSession(owner, {id: scope.sessionId, title: '', agentId: profile.spec.id, revision: profile.revision, workspaceId: attachedWorkspace, updatedAt: new Date().toISOString()});
      return true;
    });
  }

  async nativeHeader(input: SessionScope) {
    const scope = this.assertScope(input);
    return readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))?.header;
  }

  async nativePage(input: SessionScope, raw: unknown): Promise<Response> {
    const scope = this.assertScope(input);
    const {request} = sessionRemote.methods['session/page'].input({strict: true}).create().parse({request: raw});
    if (request.address.kind !== 'session' || request.address.sessionId !== scope.sessionId) throw new Error('Session address mismatch');
    return Response.json(await (await this.getReader()).history.page(request, new AbortController().signal));
  }

  async nativeRename(input: SessionScope, title: string) {
    const scope = this.assertScope(input);
    const active = (await this.getReader()).activeRuntime();
    if (active?.ctx.get('sessionTitle')) return renameLiveHarnessSession(active.ctx, active.agent, title);
    return this.exclusive(async () => {
      const stored = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string}>('SELECT workspace_id,agent_document FROM weft_session_config WHERE id=1').one();
      const profile = JSON.parse(stored.agent_document) as AgentRevision;
      const runtime = sessionRuntime(this.env, this.ctx.storage, scope, profile, stored.workspace_id, profile.spec.persona, true, await this.getReader());
      return renameHarnessSession(runtime.options, title);
    });
  }

  async nativeStatus(input: SessionScope): Promise<NativeSummary | undefined> {
    const scope = this.assertScope(input);
    const row = this.ctx.storage.sql.exec<{header_json: string; event_count: number}>('SELECT header_json,event_count FROM harness_sessions WHERE id=?', scope.sessionId).toArray()[0];
    if (!row) return undefined;
    const header = JSON.parse(row.header_json) as import('@deepseek-ai/dsh-session').SessionHeader;
    const last = this.ctx.storage.sql.exec<{time: number}>("SELECT MAX(json_extract(event_json,'$.time')) AS time FROM harness_events WHERE session_id=? AND json_extract(event_json,'$.type')='user/message' AND json_extract(event_json,'$.data.source.kind')='user'", scope.sessionId).one();
    const turn = this.ctx.storage.sql.exec("SELECT seq FROM harness_events WHERE session_id=? AND json_extract(event_json,'$.type')='turn/start' LIMIT 1", scope.sessionId).toArray().length > 0;
    return {sessionId: header.id, updatedAt: last.time ?? header.createdAt, running: this.requests.size > 0, agentAvailable: this.requests.size > 0, blank: !turn, ...(header.cwd ? {cwd: header.cwd} : {}), formatStatus: 'current' as const};
  }

  async nativeProjections(input: SessionScope): Promise<Response> {
    const scope = this.assertScope(input);
    if (!this.ctx.storage.sql.exec('SELECT id FROM harness_sessions WHERE id=?', scope.sessionId).toArray().length) return Response.json(null);
    using observation = await (await this.getReader()).ctx.sessionQuery.observeSession(SessionId(scope.sessionId));
    const checked = sessionRemote.methods['session/projections'].result.create().parse({kind: 'sequenced', asOfSeq: observation.cursor, values: observation.projections?.values ?? {}});
    if (checked?.kind !== 'sequenced') throw new Error('Expected current projections');
    return Response.json(checked);
  }

  async nativePrompt(input: SessionScope, raw: unknown): Promise<void> {
    const scope = this.assertScope(input);
    const {request} = sessionRemote.methods['session/prompt'].input({strict: true}).create().parse({request: raw});
    if (request.sessionId !== scope.sessionId) throw new Error('Session identity mismatch');
    if (!readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) throw new RemoteError('session/not-found', 'Session not found', {sessionId: request.sessionId});
    if (request.mode === 'steer') throw new RemoteError('session/agent-busy', 'Steering is not connected yet', {reason: 'steer-unavailable'});
    if (request.content.some(part => part.type !== 'text')) throw new RemoteError('session/attachment-invalid', 'Attachment admission is not connected yet', {reason: 'attachment-unavailable'});
    const text = request.content.map(part => part.type === 'text' ? part.text : '').join('');
    if (!text.trim()) throw new RemoteError('gateway/bad-request', 'Prompt content is empty', {});
    if (request.clientTimeZone !== undefined) {
      try { new Intl.DateTimeFormat('en', {timeZone: request.clientTimeZone}); }
      catch { throw new RemoteError('session/invalid-time-zone', 'Invalid client time zone', {value: request.clientTimeZone}); }
    }
    const pending = this.nativeAdmissions.get(request.requestId);
    if (pending) return pending;
    const seen = this.ctx.storage.sql.exec("SELECT seq FROM harness_events WHERE session_id=? AND json_extract(event_json,'$.data.source.rpcId')=? LIMIT 1", scope.sessionId, request.requestId).toArray().length;
    if (seen) return;
    if (this.requests.size > 0) throw new RemoteError('session/agent-busy', 'Native inbox queue admission is not connected yet', {reason: 'queue-unavailable'});
    let admitted = false;
    let accept!: () => void;
    let refuse!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => {accept = resolve; refuse = reject;});
    this.nativeAdmissions.set(request.requestId, admission);
    const operation = this.execute(scope, text, '', request.requestId, undefined, undefined, {
      onEvent: event => {
        if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === request.requestId) {
          admitted = true;
          accept();
        }
      },
    }, request);
    this.ctx.waitUntil(operation.then(result => {
      if (!admitted) refuse(!result.ok && result.error.code === 'MODEL_NOT_CONFIGURED'
        ? new RemoteError('session/provider-credentials-unavailable', result.error.message, {})
        : new RemoteError('gateway/internal', result.ok ? 'Prompt was not admitted' : result.error.message, {}));
      else if (!result.ok) console.error('Native prompt failed', result.error.code);
    }, error => { refuse(error); }));
    try { await admission; await this.ctx.storage.sync(); }
    finally { this.nativeAdmissions.delete(request.requestId); }
  }

  async nativeCancel(input: SessionScope): Promise<void> {
    this.assertScope(input);
    for (const id of this.requests.keys()) await this.cancel(input, id);
  }

  /** Internal binding transport; external requests are authenticated by the entry Worker. */
  override async fetch(request: Request): Promise<Response> {
    const raw: unknown = await request.json();
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-follow') {
      const envelope = z.object({scope: scopeSchema, operation: z.literal('native-follow'), args: z.unknown()}).strict().parse(raw);
      const scope = this.assertScope(envelope.scope);
      const args = sessionRemote.methods['session/follow'].input({strict: true}).create().parse(envelope.args);
      if (args.request.address.kind !== 'session' || args.request.address.sessionId !== scope.sessionId) throw new Error('Session address mismatch');
      const abort = new AbortController();
      request.signal.addEventListener('abort', () => abort.abort(), {once: true});
      const reader = await this.getReader();
      const codec = sessionRemote.methods['session/follow'].result.create();
      return remoteStream(reader.history.follow(args.request, abort.signal), abort, value => codec.parse(value));
    }
    const payload = z.object({ scope: scopeSchema, text: z.string().min(1).max(8000), persona: z.string().max(4000), requestId: z.uuid(), workspaceId: workspaceIdSchema.optional(), agent: agentBindingSchema.optional() }).strict().parse(raw);
    this.assertScope(payload.scope);
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        const publish = (event: string, data: unknown) => {
          if (cancelled) return;
          if ((controller.desiredSize ?? 0) < -1_048_576) {
            cancelled = true;
            void this.cancel(payload.scope, payload.requestId);
            controller.error(new Error('Stream consumer is too slow'));
            return;
          }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        publish('session', { ...payload.scope, requestId: payload.requestId });
        heartbeat = setInterval(() => { publish('ping', { requestId: payload.requestId }); }, 5000);
        const operation = this.execute(payload.scope, payload.text, payload.persona, payload.requestId, payload.workspaceId, payload.agent, {
          onEvent: event => { publish('session-event', event); },
          onFrame: frame => { publish('assistant-stream', frame); },
        }).then(result => {
          if (result.ok) publish('done', { requestId: result.requestId, model: result.model });
          else publish('error', { requestId: result.requestId, ...result.error });
        }).finally(() => { clearInterval(heartbeat); if (!cancelled) controller.close(); });
        this.ctx.waitUntil(operation);
      },
      cancel: () => { cancelled = true; clearInterval(heartbeat); void this.cancel(payload.scope, payload.requestId); },
    }, { highWaterMark: 65_536, size: chunk => chunk.byteLength });
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store', 'x-weft-request-id': payload.requestId } });
  }

  async events(input: SessionScope): Promise<readonly SessionEvent[] | undefined> {
    const scope = this.assertScope(input);
    return this.exclusive(async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(SqliteSessionPersistence, { storage: this.ctx.storage });
        const id = SessionId(scope.sessionId);
        if (!await ctx.sessionPersistence.stat(id)) return undefined;
        const handle = await ctx.sessionPersistence.open(id, 'read');
        try { return (await handle.read()).events; } finally { await handle.close(); }
      } finally { await ctx.fiber.dispose(); }
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      let pathname = new URL(request.url).pathname;
      const principal = await authenticateAccess(ctx.access, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN);
      if (!principal) throw new HttpError(401, 'Cloudflare Access user login required');
      const ui = serveUi(request, env.UI);
      if (ui) return await ui;
      if (pathname === '/v1/me' && request.method === 'GET') {
        return Response.json({ user: { id: principal.userId, email: principal.email }, tenantId: principal.tenantId }, {
          headers: { 'cache-control': 'private, no-store' },
        });
      }
      if (pathname === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', mode: 'harness', backend: env.MODEL_BACKEND ?? 'unconfigured' });
      }
      const environment = await resolveEnvironmentRequest(request, env, principal);
      if (environment.response) return environment.response;
      request = environment.request;
      pathname = new URL(request.url).pathname;
      const nativeResponse = await handleNativeRequest(request, env, principal, environment.environmentId);
      if (nativeResponse) return nativeResponse;
      const workspaceResponse = await handleWorkspaceRequest(request, env, principal, environment.environmentId);
      if (workspaceResponse) return workspaceResponse;
      const controlResponse = await handleControlRequest(request, env, principal, environment.environmentId);
      if (controlResponse) return controlResponse;
      const match = /^\/v1\/tenants\/([^/]+)\/sessions\/([^/]+)\/(messages|events|cancel)$/.exec(pathname);
      if (!match) throw new HttpError(404, 'Not found');
      const parsed = scopeSchema.safeParse({ tenantId: match[1], sessionId: match[2], ...(environment.environmentId ? { environmentId: environment.environmentId } : {}) });
      if (!parsed.success) throw new HttpError(400, 'Invalid session identity');
      const scope = parsed.data;
      if (scope.tenantId !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
      const session = env.SESSIONS.getByName(sessionAddress(scope));
      if ((match[3] === 'messages' || match[3] === 'cancel') && request.method === 'POST') {
        assertSameOrigin(request);
        const raw = await readJson(request);
        if (match[3] === 'cancel') {
          const parsed = cancelSchema.safeParse(raw);
          if (!parsed.success) throw new HttpError(400, 'Invalid cancellation body');
          return Response.json({ requestId: parsed.data.requestId, cancelled: await session.cancel(scope, parsed.data.requestId) });
        }
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, 'Invalid message body');
        const { text } = parsed.data;
        const requestId = parsed.data.requestId ?? crypto.randomUUID();
        const persona = `You are the assistant for tenant ${principal.tenantId}.`;
        if (request.headers.get('accept')?.split(',').some(type => type.trim().split(';')[0] === 'text/event-stream')) {
          const stop = () => { ctx.waitUntil(session.cancel(scope, requestId).then(() => {})); };
          request.signal.addEventListener('abort', stop, { once: true });
          const response = await session.fetch(new Request('https://session.internal/turn', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope, text, persona, requestId, workspaceId: parsed.data.workspaceId, agent: parsed.data.agent }),
          }));
          if (request.signal.aborted) stop();
          return response;
        }
        return await session.send(scope, text, persona, requestId, parsed.data.workspaceId, parsed.data.agent);
      }
      if (match[3] === 'events' && request.method === 'GET') {
        const events = await session.events(scope);
        if (!events) throw new HttpError(404, 'Session not found');
        return Response.json({ ...scope, events });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { allow: match[3] === 'events' ? 'GET' : 'POST' } });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      console.error('Weft validation request failed', error);
      return Response.json({ error: 'Internal validation failure' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
