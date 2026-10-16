import { DurableObject } from 'cloudflare:workers';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn } from '../../packages/harness-runtime/src/runtime.ts';
import { ScriptedAdapter } from '../../packages/harness-runtime/src/scripted-adapter.ts';
import { registerIdentityTool } from '../../packages/harness-runtime/src/validation-tools.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../packages/session-persistence-do/src/index.ts';
import { SessionDO } from '../../apps/worker/src/index.ts';

export { SessionDO };

interface Env { CONTRACTS: DurableObjectNamespace<ContractsDO>; SESSIONS: DurableObjectNamespace<SessionDO> }

async function failure(operation: () => Promise<unknown>): Promise<string> {
  try { await operation(); return 'NO_ERROR'; }
  catch (error) { return error instanceof Error ? error.name : String(error); }
}

/** Test-only fault injection. This entrypoint is never part of the application Worker. */
export class ContractsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
  }

  async checkScope() {
    const session = this.env.SESSIONS.getByName(JSON.stringify(['alpha', 'same-id']));
    let wrongScope = 'NO_ERROR';
    try { await session.events({ tenantId: 'beta', sessionId: 'same-id' }); }
    catch (error) { wrongScope = error instanceof Error ? error.message : String(error); }
    const correctScope = await session.events({ tenantId: 'alpha', sessionId: 'same-id' });
    return { wrongScope, correctScopeHasNoEvents: correctScope === undefined };
  }

  async checkStorage() {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(SqliteSessionPersistence, { storage: this.ctx.storage });
      const service = ctx.sessionPersistence;
      const id = SessionId('storage');
      const header = ctx.sessions.prepare(id).header;
      const writer = await service.create(header);
      const duplicateCreate = await failure(() => service.create(header));
      const duplicateWriter = await failure(() => service.open(id, 'write'));
      const reader = await service.open(id, 'read');
      const start: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } };
      const end: SessionEvent = { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } };
      await writer.append([start]);
      const visibleWhileWriting = (await reader.read()).events.length;
      const readOnlyAppend = await failure(() => reader.append([end]));
      const readOnlyFlush = await failure(() => reader.flush());
      const invalidBatch = await failure(() => writer.append([end, { ...start, seq: SessionSeq(3) }]));
      const countAfterRefusal = (await service.stat(id))?.eventCount;
      await writer.append([end]);
      await service.flush();
      const slice = await reader.read(1, 1);
      const listed = await service.list();
      const close = writer.close();
      const idempotentClose = close === writer.close();
      await close;
      const closedRead = await failure(() => writer.read());
      const replacement = await service.open(id, 'write');
      await replacement.close();
      await reader.close();

      const aborted = new AbortController();
      aborted.abort();
      const cancelledOpen = await failure(() => service.open(id, 'write', { signal: aborted.signal }));

      const stale = await service.open(id, 'write');
      initializeSessionStorage(this.ctx.storage);
      const newWriter = await service.open(id, 'write');
      const staleAppend = await failure(() => stale.append([]));
      const staleClose = await failure(() => stale.close());
      const replacementProtected = await failure(() => service.open(id, 'write'));
      await newWriter.close();

      this.ctx.storage.sql.exec(
        'UPDATE harness_sessions SET header_json = ? WHERE id = ?', JSON.stringify({ ...header, version: header.version + 1 }), id,
      );
      const futureVersion = await failure(() => service.open(id, 'read'));
      this.ctx.storage.sql.exec('UPDATE harness_sessions SET header_json = ? WHERE id = ?', JSON.stringify(header), id);
      this.ctx.storage.sql.exec('UPDATE harness_events SET event_json = ? WHERE session_id = ? AND seq = 0', JSON.stringify({ ...start, type: 'future/required' }), id);
      const futureReader = await service.open(id, 'read');
      const unknownRequiredEvent = await failure(() => futureReader.read());
      await futureReader.close();

      return {
        duplicateCreate, duplicateWriter, visibleWhileWriting, readOnlyAppend, readOnlyFlush,
        invalidBatch, countAfterRefusal, slice: slice.events.map(event => event.type),
        listedCount: listed.length, idempotentClose, closedRead, cancelledOpen,
        staleAppend, staleClose, replacementProtected, futureVersion, unknownRequiredEvent,
      };
    } finally { await ctx.fiber.dispose(); }
  }

  async resumeInterrupted(prefix: readonly SessionEvent[]) {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(SqliteSessionPersistence, { storage: this.ctx.storage });
      const header = ctx.sessions.prepare(SessionId('interrupted')).header;
      const handle = await ctx.sessionPersistence.create(header);
      await handle.append(prefix);
      await handle.flush();
      await handle.close();
    } finally { await ctx.fiber.dispose(); }
    return runHarnessTurn({
      sessionId: 'interrupted', persona: 'Recovery validation', model: { provider: 'validation', model: 'scripted' }, adapter: new ScriptedAdapter(),
      mountPersistence: async runtime => { await runtime.plugin(SqliteSessionPersistence, { storage: this.ctx.storage }); },
      mountTools: async runtime => { registerIdentityTool(runtime, 'alpha'); },
    }, 'Continue with a fresh turn');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const object = env.CONTRACTS.getByName(crypto.randomUUID());
    if (new URL(request.url).pathname === '/scope') return Response.json(await object.checkScope());
    if (new URL(request.url).pathname === '/storage') return Response.json(await object.checkStorage());
    return Response.json(await object.resumeInterrupted(await request.json()));
  },
} satisfies ExportedHandler<Env>;
