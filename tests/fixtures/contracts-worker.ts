import { Workspace } from '@cloudflare/computer';
import { WorkspaceStore } from '../../packages/workspace/src/store.ts';
import { WorkspaceDO } from '../../packages/workspace/src/object.ts';
import { DurableObject } from 'cloudflare:workers';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn } from '../../packages/harness-runtime/src/runtime.ts';
import { ScriptedAdapter } from '../../packages/harness-runtime/src/scripted-adapter.ts';
import { registerIdentityTool } from '../../packages/harness-runtime/src/validation-tools.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../packages/session-persistence-do/src/index.ts';
import { SessionDO, EnvironmentDO, TenantDO } from '../../apps/worker/src/index.ts';
import { sessionAddress } from '../../packages/tenant/src/index.ts';
import { workspaceAddress } from '../../packages/workspace/src/protocol.ts';

export { SessionDO, WorkspaceDO, EnvironmentDO, TenantDO };

interface Env { CONTRACTS: DurableObjectNamespace<ContractsDO>; SESSIONS: DurableObjectNamespace<SessionDO>; WORKSPACES: DurableObjectNamespace<WorkspaceDO> }

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
    const scope = {tenantId: 'alpha', environmentId: 'one', sessionId: 'same-id'};
    const session = this.env.SESSIONS.getByName(sessionAddress(scope));
    let wrongScope = 'NO_ERROR';
    try { await session.events({...scope, tenantId: 'beta'}); }
    catch (error) { wrongScope = error instanceof Error ? error.message : String(error); }
    let wrongEnvironment = 'NO_ERROR';
    try { await session.events({...scope, environmentId: 'two'}); }
    catch (error) { wrongEnvironment = error instanceof Error ? error.message : String(error); }
    const correctScope = await session.events(scope);
    return { wrongScope, wrongEnvironment, correctScopeHasNoEvents: correctScope === undefined };
  }

  async nativeContext(stage: string) {
    const scope = {tenantId: 'alpha', environmentId: 'one', sessionId: 'plugin-context'};
    const session = this.env.SESSIONS.getByName(sessionAddress(scope));
    if (stage === 'seed') {
      await session.nativeCreate(scope);
      await session.nativePluginContext(scope, 'Plugin activation context survived', false);
    } else if (stage === 'run') {
      await session.nativePrompt(scope, {sessionId: scope.sessionId, requestId: 'plugin-context-request', mode: 'queue', content: [{type: 'text', text: 'continue'}]});
      await session.events(scope);
    }
    return {status: await session.nativeStatus(scope), projections: await (await session.nativeProjections(scope)).json(), events: await session.events(scope)};
  }

  async checkWorkspace() {
    const scoped = this.env.WORKSPACES.getByName(workspaceAddress({tenantId: 'alpha', workspaceId: 'one'}));
    const wrong = await scoped.call({ tenantId: 'beta', workspaceId: 'one' }, { type: 'list', path: '/workspace' });
    const files = new WorkspaceStore(this.ctx.storage);
    const computer = new Workspace({ storage: this.ctx.storage, output: false });
    computer.provider().symlinkSync('/outside', '/workspace/escape');
    let symlink = '';
    try { files.execute({ type: 'read', path: '/workspace/escape/secret' }); } catch (error) { symlink = (error as { code: string }).code; }
    computer.provider().unlinkSync('/workspace/escape');
    this.ctx.storage.sql.exec("CREATE TRIGGER reject_version BEFORE INSERT ON weft_file_versions BEGIN SELECT RAISE(ABORT, 'injected'); END");
    let rejected = '';
    try { files.execute({ type: 'write', path: '/workspace/subdir/atomic.txt', content: 'must roll back' }); } catch (error) { rejected = (error as { code: string }).code; }
    const afterRollback = files.execute({ type: 'list', path: '/workspace' });
    this.ctx.storage.sql.exec('DROP TRIGGER reject_version');
    const committed = files.execute({ type: 'write', path: '/workspace/ok.txt', content: 'ok' }) as { revision: number };
    computer.provider().writeFileSync('/workspace/binary.dat', Buffer.from([0, 255, 65]));
    const bytes = files.execute({ type: 'bytes', path: '/workspace/binary.dat', offset: 1, length: 2 }) as Uint8Array;
    let binary = '';
    try { files.execute({ type: 'read', path: '/workspace/binary.dat' }); } catch (error) { binary = (error as { code: string }).code; }
    this.ctx.storage.sql.exec('UPDATE weft_workspace_schema SET version=99');
    let futureFormat = '';
    try { new WorkspaceStore(this.ctx.storage); } catch (error) { futureFormat = (error as Error).message; }
    return { wrongScope: wrong.status, symlink, rejected, afterRollback, revisionAfterRollback: committed.revision, bytes: Array.from(bytes), binary, futureFormat };
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
    if (new URL(request.url).pathname === '/native-context') return Response.json(await object.nativeContext(new URL(request.url).searchParams.get('stage') ?? 'read'));
    if (new URL(request.url).pathname === '/scope') return Response.json(await object.checkScope());
    if (new URL(request.url).pathname === '/workspace-contracts') return Response.json(await object.checkWorkspace());
    if (new URL(request.url).pathname === '/storage') return Response.json(await object.checkStorage());
    return Response.json(await object.resumeInterrupted(await request.json()));
  },
} satisfies ExportedHandler<Env>;
