import { Workspace } from '@cloudflare/computer';
import { WorkspaceStore } from '../../packages/workspace/src/store.ts';
import { WorkspaceDO as BaseWorkspaceDO } from '../../packages/workspace/src/object.ts';
import { DurableObject } from 'cloudflare:workers';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn } from '../../packages/harness-runtime/src/runtime.ts';
import { ScriptedAdapter } from '../../packages/harness-runtime/src/scripted-adapter.ts';
import { registerIdentityTool } from '../../packages/harness-runtime/src/validation-tools.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../packages/session-persistence-do/src/index.ts';
import { SessionDO, EnvironmentDO, TenantDO, PluginCapabilities } from '../../apps/worker/src/index.ts';
import { sessionAddress } from '../../packages/tenant/src/index.ts';
import { workspaceAddress, workspaceScopeSchema, type WorkspaceScope } from '../../packages/workspace/src/protocol.ts';
import {ComputerAttachmentStore} from '../../packages/native-attachments/src/store.ts';
import {ATTACHMENT_ROOT, attachmentOperationSchema, type AttachmentOperation} from '../../packages/native-attachments/src/storage.ts';
import {AttachmentError} from '@deepseek-ai/dsh-attachment';
import {storedFilePath} from '../../.generated/official-file-reference.ts';
import {createHash} from 'node:crypto';
import type {FileAttachmentRef} from '@deepseek-ai/dsh-attachment';

export { SessionDO, EnvironmentDO, TenantDO, PluginCapabilities };
/** Test-only visibility into persistence checkpoints, absent from the production Worker. */
export class WorkspaceDO extends BaseWorkspaceDO {
  private readonly testFiles: WorkspaceStore;
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, env); this.testFiles = new WorkspaceStore(ctx.storage);}
  /** Private upload capability; it never becomes a filesystem tool operation. */
  async attachment(input: WorkspaceScope, raw: AttachmentOperation): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    const parsed = attachmentOperationSchema.safeParse(raw);
    if (!parsed.success) return Response.json({error: 'Invalid attachment operation', code: 'ATTACHMENT_WRITE_FAILED'}, {status: 400});
    try {
      const value = this.testFiles.attachments.execute(parsed.data);
      await this.ctx.storage.sync();
      if (value instanceof Uint8Array) return new Response(new Uint8Array(value).buffer, {headers: {'content-type': 'application/octet-stream', 'cache-control': 'private, no-store'}});
      return Response.json({value}, {headers: {'cache-control': 'private, no-store'}});
    } catch (error) {
      const failure = error instanceof AttachmentError ? error : new AttachmentError('Attachment storage operation failed.', parsed.data.type === 'read' ? 'ATTACHMENT_READ_FAILED' : 'ATTACHMENT_WRITE_FAILED');
      return Response.json({error: failure.message, code: failure.code}, {status: failure.code === 'ATTACHMENT_NOT_FOUND' ? 404 : 400});
    }
  }

  async stagedBytes(): Promise<number> {
    return this.ctx.storage.sql.exec<{bytes: number}>('SELECT COALESCE(SUM(bytes),0) AS bytes FROM weft_attachment_uploads').one().bytes;
  }
}

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

  async checkAttachments() {
    const scope = {tenantId: 'alpha', workspaceId: 'attachment-cleanup'};
    const stub = this.env.WORKSPACES.getByName(workspaceAddress(scope));
    const wrong = await stub.uploadAttachment({...scope, tenantId: 'beta'}, 'owner', undefined, new ReadableStream({type: 'bytes', start(controller) {controller.close();}}));
    const ctx = new Context();
    let interrupted = 0;
    let uploadCalls = 0, readCalls = 0;
    const transport = {
      uploadAttachment: async (...args: Parameters<typeof stub.uploadAttachment>) => {uploadCalls++; return await stub.uploadAttachment(...args);},
      readAttachment: async (...args: Parameters<typeof stub.readAttachment>) => {readCalls++; return await stub.readAttachment(...args);},
    };
    try {
      await ctx.plugin(ComputerAttachmentStore, {scope, sessionId: 'owner', transport});
      for (let i = 0; i < 16; i++) {
        try {
          await ctx.attachments.saveFileStream({data: (async function* () {yield new Uint8Array(65_536); while (await stub.stagedBytes() < 65_536) await new Promise(resolve => setTimeout(resolve, 1)); throw new Error('injected upload interruption');})()});
        } catch (error) {if (error instanceof Error && error.message === 'injected upload interruption') interrupted++;}
      }
      const abort = new AbortController();
      let cancelled = false;
      try {
        await ctx.attachments.saveFileStream({signal: abort.signal, data: (async function* () {
          yield new Uint8Array(65_536);
          while (await stub.stagedBytes() < 65_536) await new Promise(resolve => setTimeout(resolve, 1));
          abort.abort(new Error('injected upload cancellation'));
        })()});
      } catch (error) {cancelled = error instanceof Error && error.message === 'injected upload cancellation';}
      const ids: string[] = [];
      for (let i = 0; i < 16; i++) {
        const response = await stub.attachment(scope, {type: 'begin', sessionId: 'owner'});
        if (!response.ok) throw new Error('Interrupted upload leaked a staging slot');
        ids.push(((await response.json()) as {value: {uploadId: string}}).value.uploadId);
      }
      const bounded = await stub.attachment(scope, {type: 'begin', sessionId: 'owner'});
      for (const uploadId of ids) await (await stub.attachment(scope, {type: 'abort', sessionId: 'owner', uploadId})).json();
      const successful = await ctx.attachments.saveFile({name: 'good.bin', data: new Uint8Array([0, 255, 1, 2])});
      const verified: number[] = [];
      for await (const chunk of ctx.attachments.readFileStream(successful)) verified.push(...chunk);
      uploadCalls = 0; readCalls = 0;
      const expected = createHash('sha256');
      const large = await ctx.attachments.saveFileStream({name: 'large.bin', data: (async function* () {
        for (let i = 0; i < 34; i++) {
          const chunk = new Uint8Array(1024 * 1024);
          for (let start = 0; start < chunk.length; start += 65_536) crypto.getRandomValues(chunk.subarray(start, start + 65_536));
          expected.update(chunk);
          yield chunk;
        }
      })()});
      const actual = createHash('sha256');
      let largeBytes = 0;
      for await (const chunk of ctx.attachments.readFileStream(large)) {actual.update(chunk); largeBytes += chunk.byteLength;}
      const largeIntegrity = actual.digest('hex') === expected.digest('hex');

      const files = new WorkspaceStore(this.ctx.storage);
      const begin = files.attachments.execute({type: 'begin', sessionId: 'owner', name: 'atomic.bin'}) as {uploadId: string};
      const apply = (sessionId: string, offset: number) => files.attachments.execute({type: 'append', sessionId, uploadId: begin.uploadId, offset, data: new Uint8Array([0, 255, 1, 2])});
      const code = (operation: () => unknown) => {try {operation(); return 'NO_ERROR';} catch (error) {return (error as {code?: string}).code ?? 'STORAGE_FAILURE';}};
      apply('owner', 0);
      const foreign = code(() => apply('other-session', 4));
      const order = code(() => apply('owner', 1));
      const corrupt = code(() => files.attachments.execute({type: 'commit', sessionId: 'owner', uploadId: begin.uploadId, sha256: '0'.repeat(64)}));
      this.ctx.storage.sql.exec("CREATE TRIGGER reject_attachment_version BEFORE INSERT ON weft_file_versions BEGIN SELECT RAISE(ABORT, 'injected'); END");
      const sha256 = createHash('sha256').update(new Uint8Array([0, 255, 1, 2])).digest('hex');
      const commit = () => files.attachments.execute({type: 'commit', sessionId: 'owner', uploadId: begin.uploadId, sha256});
      const publication = code(commit);
      const afterRollback = files.execute({type: 'list', path: '/workspace'});
      const stagedAfterRollback = this.ctx.storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_attachment_uploads').one().count;
      this.ctx.storage.sql.exec('DROP TRIGGER reject_attachment_version');
      const ref = commit() as FileAttachmentRef;
      const path = storedFilePath(ATTACHMENT_ROOT, ref);
      const immutable = code(() => files.execute({type: 'write', path, content: 'tampered'}));
      const revision = this.ctx.storage.sql.exec<{revision: number}>('SELECT revision FROM weft_workspace_state WHERE id=1').one().revision;
      return {wrongScope: wrong.status, interrupted, cancelled, stagingLimit: bounded.status, verified, largeBytes, largeIntegrity, uploadCalls, readCalls, foreign, order, corrupt, publication, afterRollback, stagedAfterRollback, immutable, revision};
    } finally {await ctx.fiber.dispose();}
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
    if (new URL(request.url).pathname === '/attachment-contracts') return Response.json(await object.checkAttachments());
    if (new URL(request.url).pathname === '/storage') return Response.json(await object.checkStorage());
    return Response.json(await object.resumeInterrupted(await request.json()));
  },
} satisfies ExportedHandler<Env>;
