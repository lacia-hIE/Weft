import { DurableObject } from 'cloudflare:workers';
import { HttpError, readJson, assertSameOrigin } from './http.ts';
import { handleWorkspaceRequest } from './workspace-http.ts';
import { mountWorkspace } from '../../../packages/workspace/src/provider.ts';
import { WorkspaceDO } from '../../../packages/workspace/src/object.ts';
import { workspaceIdSchema, workspaceAddress } from '../../../packages/workspace/src/protocol.ts';
export { WorkspaceDO };
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn } from '../../../packages/harness-runtime/src/runtime.ts';
import { resolveTenantModel, turnFailure, type ModelEnvironment, type TurnFailure } from '../../../packages/model-provider/src/index.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import { registerIdentityTool } from '../../../packages/harness-runtime/src/validation-tools.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../../packages/session-persistence-do/src/index.ts';
import { authenticateAccess, sessionAddress, scopeSchema, type SessionScope } from '../../../packages/tenant/src/index.ts';

export interface Env extends ModelEnvironment {
  SESSIONS: DurableObjectNamespace<SessionDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

const messageSchema = z.object({ text: z.string().min(1).max(8000), requestId: z.uuid().optional(), workspaceId: workspaceIdSchema.optional() }).strict();
const cancelSchema = z.object({ requestId: z.uuid() }).strict();
type TurnResult = { ok: true; requestId: string; events: readonly SessionEvent[]; model: { provider: string; model: string } }
  | { ok: false; requestId: string; error: TurnFailure };

/** One tenant-qualified session. RPC methods are reachable only through trusted bindings. */
export class SessionDO extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();
  private readonly requests = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_session_config (id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT)');
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

  async send(input: SessionScope, text: string, persona: string, requestId: string, workspaceId?: string): Promise<Response> {
    const result = await this.execute(input, text, persona, requestId, workspaceId);
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
    hooks: Pick<RuntimeOptions, 'onEvent' | 'onFrame'> = {},
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
          const resolved = resolveTenantModel(this.env, scope.tenantId);
          const stored = this.ctx.storage.sql.exec<{ workspace_id: string | null }>('SELECT workspace_id FROM weft_session_config WHERE id=1').toArray()[0];
          if (workspaceId !== undefined) workspaceIdSchema.parse(workspaceId);
          if (stored && workspaceId !== undefined && workspaceId !== stored.workspace_id) {
            return { ok: false, requestId, error: { code: 'WORKSPACE_MISMATCH', message: 'Session is already bound to another workspace', status: 409 } };
          }
          const attachedWorkspace = stored ? stored.workspace_id : workspaceId ?? null;
          if (!stored) this.ctx.storage.sql.exec('INSERT INTO weft_session_config VALUES (1, ?)', attachedWorkspace);
          timer = setTimeout(() => { controller.abort({ code: 'TURN_TIMEOUT', message: 'Turn deadline exceeded', status: 504 } satisfies TurnFailure); }, resolved.turnTimeoutMs);
          const events = await runHarnessTurn({
            sessionId: scope.sessionId, persona, model: resolved.model, adapter: resolved.adapter,
            signal: controller.signal, ...hooks,
            cancellationCause: () => controller.signal.reason?.code === 'TURN_TIMEOUT' ? { kind: 'hook', reason: 'turn-deadline' } : { kind: 'user' },
            mountPersistence: async ctx => { await ctx.plugin(SqliteSessionPersistence, { storage: this.ctx.storage }); },
            mountTools: async ctx => {
              registerIdentityTool(ctx, scope.tenantId);
              if (attachedWorkspace !== null) {
                const workspaceScope = { tenantId: scope.tenantId, workspaceId: attachedWorkspace };
                await mountWorkspace(ctx, { scope: workspaceScope, transport: this.env.WORKSPACES.getByName(workspaceAddress(workspaceScope)) });
              }
            },
          }, text);
          return { ok: true, requestId, events, model: resolved.model };
        } catch (error) {
          return { ok: false, requestId, error: controller.signal.aborted ? controller.signal.reason as TurnFailure : turnFailure(error) };
        } finally { if (timer !== undefined) clearTimeout(timer); }
      });
    } finally { this.requests.delete(requestId); }
  }

  /** Internal binding transport; external requests are authenticated by the entry Worker. */
  override async fetch(request: Request): Promise<Response> {
    const payload = z.object({ scope: scopeSchema, text: z.string().min(1).max(8000), persona: z.string().max(4000), requestId: z.uuid(), workspaceId: workspaceIdSchema.optional() }).strict().parse(await request.json());
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
        const operation = this.execute(payload.scope, payload.text, payload.persona, payload.requestId, payload.workspaceId, {
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
      const pathname = new URL(request.url).pathname;
      const principal = await authenticateAccess(ctx.access, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN);
      if (!principal) throw new HttpError(401, 'Cloudflare Access user login required');
      if ((pathname === '/' || pathname === '/v1/me') && request.method === 'GET') {
        return Response.json({ user: { id: principal.userId, email: principal.email }, tenantId: principal.tenantId }, {
          headers: { 'cache-control': 'private, no-store' },
        });
      }
      if (pathname === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', mode: 'harness', backend: env.MODEL_BACKEND ?? 'unconfigured' });
      }
      const workspaceResponse = await handleWorkspaceRequest(request, env, principal);
      if (workspaceResponse) return workspaceResponse;
      const match = /^\/v1\/tenants\/([^/]+)\/sessions\/([^/]+)\/(messages|events|cancel)$/.exec(pathname);
      if (!match) throw new HttpError(404, 'Not found');
      const parsed = scopeSchema.safeParse({ tenantId: match[1], sessionId: match[2] });
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
            body: JSON.stringify({ scope, text, persona, requestId, workspaceId: parsed.data.workspaceId }),
          }));
          if (request.signal.aborted) stop();
          return response;
        }
        return await session.send(scope, text, persona, requestId, parsed.data.workspaceId);
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
