import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn } from '../../../packages/harness-runtime/src/runtime.ts';
import { ScriptedAdapter } from '../../../packages/harness-runtime/src/scripted-adapter.ts';
import { registerIdentityTool } from '../../../packages/harness-runtime/src/validation-tools.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../../packages/session-persistence-do/src/index.ts';
import { authenticate, sessionAddress, scopeSchema, type SessionScope } from '../../../packages/tenant/src/index.ts';

export interface Env {
  SESSIONS: DurableObjectNamespace<SessionDO>;
  VALIDATION_AUTH_JSON?: string;
}

const messageSchema = z.object({ text: z.string().min(1).max(8000) }).strict();

/** One tenant-qualified session. RPC methods are reachable only through trusted bindings. */
export class SessionDO extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
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

  async send(input: SessionScope, text: string, persona: string): Promise<readonly SessionEvent[]> {
    const scope = this.assertScope(input);
    return this.exclusive(() => runHarnessTurn({
      sessionId: scope.sessionId, persona, model: { provider: 'validation', model: 'scripted' }, adapter: new ScriptedAdapter(),
      mountPersistence: async ctx => { await ctx.plugin(SqliteSessionPersistence, { storage: this.ctx.storage }); },
      mountTools: async ctx => { registerIdentityTool(ctx, scope.tenantId); },
    }, text));
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

async function readMessage(request: Request): Promise<{ text: string }> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing JSON body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new HttpError(413, 'Message body is too large');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return messageSchema.parse(JSON.parse(new TextDecoder().decode(body))); }
  catch { throw new HttpError(400, 'Invalid message body'); }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', mode: 'harness-validation', model: 'scripted' });
      }
      const principal = authenticate(request, env.VALIDATION_AUTH_JSON);
      if (!principal) throw new HttpError(401, 'Authentication required');
      const match = /^\/v1\/tenants\/([^/]+)\/sessions\/([^/]+)\/(messages|events)$/.exec(pathname);
      if (!match) throw new HttpError(404, 'Not found');
      const parsed = scopeSchema.safeParse({ tenantId: match[1], sessionId: match[2] });
      if (!parsed.success) throw new HttpError(400, 'Invalid session identity');
      const scope = parsed.data;
      if (scope.tenantId !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
      const session = env.SESSIONS.getByName(sessionAddress(scope));
      if (match[3] === 'messages' && request.method === 'POST') {
        const { text } = await readMessage(request);
        const events = await session.send(scope, text, principal.persona);
        return Response.json({ ...scope, events });
      }
      if (match[3] === 'events' && request.method === 'GET') {
        const events = await session.events(scope);
        if (!events) throw new HttpError(404, 'Session not found');
        return Response.json({ ...scope, events });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { allow: match[3] === 'messages' ? 'POST' : 'GET' } });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      console.error('Weft validation request failed', error);
      return Response.json({ error: 'Internal validation failure' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
