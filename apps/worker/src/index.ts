import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createSessionReader } from '../../../packages/harness-runtime/src/session-reader.ts';
import { sessionRuntime } from './runtime-options.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import { remoteStream } from '../../../packages/harness-runtime/src/remote-stream.ts';
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
import {createNativeFileHost, type NativeFileEndpoint} from '../../../packages/native-files/src/index.ts';
import {referencedImage} from '../../../.generated/official-image-helpers.ts';
import {AttachmentError} from '@deepseek-ai/dsh-attachment';
import uploadRemote from '../../../.generated/official-remotes/packages/client/file-upload/typert.remote-client.js';
import {FILE_UPLOAD_PATH} from '@weft/upstream/packages/client/file-upload/src/protocol.ts';
import { workspaceIdSchema, workspaceAddress, workspacePath } from '../../../packages/workspace/src/protocol.ts';
export { WorkspaceDO, TenantDO, EnvironmentDO };
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-cordis-host-runner';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { runHarnessTurn, initializeHarnessSession, renameHarnessSession, renameLiveHarnessSession, selectHarnessModel } from '../../../packages/harness-runtime/src/runtime.ts';
import { selectLiveHarnessModel } from '../../../packages/harness-runtime/src/model-selection.ts';
import { NativeSessionHost, NativeHostReplacedError } from './native-session-host.ts';
import {replaceNativePreset, nativePresetDefinition} from '../../../packages/native-composition/src/index.ts';
import { NativePlugins, nativePlugins, type NativePluginEndpoint } from '../../../packages/native-plugins/src/host.ts';
import nativePluginRemote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import { nativePluginFsMethods } from '../../../packages/native-plugins/src/protocol.ts';
import { turnFailure, ModelConfigurationError, type ModelEnvironment, type TurnFailure } from '../../../packages/model-provider/src/index.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { initializeSessionStorage, SqliteSessionPersistence, readSessionSnapshot } from '../../../packages/session-persistence-do/src/index.ts';
import { authenticateAccess, sessionAddress, scopeSchema, type SessionScope } from '../../../packages/tenant/src/index.ts';
import {authenticateAccessAssertion, AccessAssertionUnavailable} from '../../../packages/tenant/src/access-assertion.ts';

export interface Env extends ModelEnvironment {
  LOADER?: WorkerLoader;
  IMAGES?: ImagesBinding;
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

/** Immutable capability identity; the child never receives a namespace or secret. */
export class PluginCapabilities extends WorkerEntrypoint<Env, {scope: SessionScope; pluginId: string; runId: string}> {
  async callFs(method: string, args: unknown[]): Promise<unknown> {
    const {scope, pluginId, runId} = this.ctx.props;
    return this.env.SESSIONS.getByName(sessionAddress(scope)).nativePluginFs(scope, pluginId, runId, method, args);
  }
}

/** One tenant-qualified session. RPC methods are reachable only through trusted bindings. */
export class SessionDO extends DurableObject<Env> {
  private readerPromise: Promise<Awaited<ReturnType<typeof createSessionReader>>> | undefined;
  private ownerScope: SessionScope | undefined;
  private readonly fileObservers = new Map<string, () => Promise<void>>();
  private readonly cancelledFileObservers = new Map<string, number>();
  private async getReader() {
    const reader = await (this.readerPromise ??= createSessionReader(this.ctx.storage));
    const config = this.ctx.storage.sql.exec<{workspace_id: string}>('SELECT workspace_id FROM weft_session_config WHERE id=1 AND presentation=1').toArray()[0];
    if (config && this.ownerScope) {
      const scope = {tenantId: this.ownerScope.tenantId, environmentId: this.ownerScope.environmentId ?? 'default', workspaceId: config.workspace_id};
      const transport = this.env.WORKSPACES.getByName(workspaceAddress(scope));
      await reader.configureWorkspace({scope, transport, attachmentTransport: transport, sessionId: this.ownerScope.sessionId, cwd: this.nativeCwd(this.ownerScope.sessionId), ...(this.env.IMAGES ? {images: this.env.IMAGES} : {})});
    }
    return reader;
  }
  private tail: Promise<void> = Promise.resolve();
  private readonly requests = new Map<string, AbortController>();
  private nativeHost: NativeSessionHost | undefined;
  private nativeHostPromise: Promise<NativeSessionHost> | undefined;
  private getNativeHost(scope: SessionScope): Promise<NativeSessionHost> {
    if (this.nativeHostPromise) return this.nativeHostPromise;
    const pending = this.exclusive(async () => {
      this.recoverNativePreset(scope);
      const stored = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string; presentation: number}>('SELECT workspace_id,agent_document,presentation FROM weft_session_config WHERE id=1').toArray()[0];
      if (!stored || stored.presentation !== 1 || !stored.agent_document) throw new RemoteError('session/not-found', 'Native Session not found', {sessionId: SessionId(scope.sessionId)});
      const profile = JSON.parse(stored.agent_document) as AgentRevision;
      if (profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, stored.workspace_id, profile.spec.persona, true, await this.getReader(), {}, this.nativeCwd(scope.sessionId), false);
      const owner = controlScope(scope.tenantId, scope.environmentId);
      const pluginsReady = Promise.withResolvers<void>();
      void pluginsReady.promise.catch(() => {});
      const host = await NativeSessionHost.open({...runtime.options, beforeAssembly: async () => {await pluginsReady.promise; await runtime.options.beforeAssembly?.();}, mountTools: async ctx => {
        await runtime.options.mountTools?.(ctx);
        await NativePlugins.mount(ctx, {
          state: this.ctx, ...(this.env.LOADER ? {loader: this.env.LOADER} : {}), scope, allowAuthoring: profile.spec.allowClientPlugins,
          capability: (pluginId, runId) => {
            const exports = this.ctx.exports as unknown as {PluginCapabilities(options: {props: {scope: SessionScope; pluginId: string; runId: string}}): Fetcher};
            return exports.PluginCapabilities({props: {scope, pluginId, runId}});
          },
          sync: (inventory, pending) => controlFor(this.env, owner).nativeSyncPlugins(owner, scope.sessionId, inventory, pending),
          event: (name, args) => controlFor(this.env, owner).nativePluginEvent(owner, scope.sessionId, name, args),
          manifest: async () => (await (await controlFor(this.env, owner).nativePluginManifest(owner)).json() as {value: unknown}).value,
        });
      }}, runtime.turnTimeoutMs, {
        waitUntil: promise => {this.ctx.waitUntil(promise);},
        changed: () => this.publishNativeSummary(scope),
        failed: failure => controlFor(this.env, owner).nativeEvent(owner, 'api-session/error', [scope.sessionId, failure.message]),
      });
      this.nativeHost = host;
      try {await nativePlugins(host.ctx)!.restore(host.agent); pluginsReady.resolve();}
      catch (error) {pluginsReady.reject(error); this.nativeHost = undefined; await host.dispose(); throw error;}
      return host;
    });
    this.nativeHostPromise = pending;
    void pending.catch(() => {if (this.nativeHostPromise === pending) this.nativeHostPromise = undefined;});
    return pending;
  }
  private nativeCwd(sessionId: string): string {
    const row = this.ctx.storage.sql.exec<{header_json: string}>('SELECT header_json FROM harness_sessions WHERE id=?', sessionId).toArray()[0];
    return workspacePath(row ? (JSON.parse(row.header_json) as {cwd?: string}).cwd ?? '/workspace' : '/workspace');
  }
  private async publishNativeSummary(scope: SessionScope): Promise<void> {
    const status = await this.nativeStatus(scope);
    if (!status) return;
    const raw: unknown = await (await this.nativeProjections(scope)).json();
    const projections = sessionRemote.methods['session/projections'].result.create().parse(raw);
    const row = {...status, ...(projections?.kind === 'sequenced' ? {projections: {kind: 'sequenced' as const, asOfSeq: projections.asOfSeq, values: projections.values}} : {})};
    const checked = sessionRemote.methods['session/list'].result.create().parse({items: [row]});
    const owner = controlScope(scope.tenantId, scope.environmentId);
    const control = controlFor(this.env, owner);
    await control.nativeEvent(owner, 'api-session/added', [checked.items[0]]);
    await control.nativeEvent(owner, 'api-session/status', [scope.sessionId, status.running]);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_session_config (id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT, agent_document TEXT, presentation INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_pending_preset (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
  }

  private assertScope(input: SessionScope): SessionScope {
    const scope = scopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.SESSIONS.idFromName(sessionAddress(scope)))) {
      throw new Error('Session scope does not match the addressed object');
    }
    this.ownerScope = scope;
    return scope;
  }
  private recoverNativePreset(scope: SessionScope): void {
    const row = this.ctx.storage.sql.exec<{document: string}>('SELECT document FROM weft_pending_preset WHERE id=1').toArray()[0];
    if (!row) return;
    const pending = JSON.parse(row.document) as {beforeSeq: number; profile: AgentRevision};
    const snapshot = readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId));
    this.ctx.storage.transactionSync(() => {
      if (snapshot?.events.some(event => event.seq > pending.beforeSeq && event.type === 'agent-preset/selected' && event.data.agentPreset === pending.profile.spec.id)) {
        this.ctx.storage.sql.exec('UPDATE weft_session_config SET agent_document=? WHERE id=1', JSON.stringify(pending.profile));
      }
      this.ctx.storage.sql.exec('DELETE FROM weft_pending_preset WHERE id=1');
    });
  }
  async nativeSelectPreset(input: SessionScope, preset: string, revision?: number): Promise<string> {
    const scope = this.assertScope(input);
    id.parse(preset);
    const host = await this.getNativeHost(scope);
    const value = await this.exclusive(() => host.reconfigureBlank(preset, async () => {
      const owner = controlScope(scope.tenantId, scope.environmentId);
      const control = controlFor(this.env, owner);
      const {value: profile} = await (await control.nativeProfile(owner, preset, revision)).json() as {value?: AgentRevision};
      if (!profile) throw new RemoteError('agent-preset/not-found', 'Unknown preset', {agentPreset: preset, available: await control.nativePresetIds(owner)});
      if (profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      const stored = this.ctx.storage.sql.exec<{agent_document: string}>('SELECT agent_document FROM weft_session_config WHERE id=1').one();
      const current = JSON.parse(stored.agent_document) as AgentRevision;
      if (current.spec.id === profile.spec.id && current.revision === profile.revision) return profile.spec.id;
      this.ctx.storage.sql.exec('INSERT INTO weft_pending_preset VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', JSON.stringify({beforeSeq: host.agent.session.seq - 1, profile}));
      try {
        await replaceNativePreset(host.ctx, nativePresetDefinition(profile));
        const selected = await host.ctx.agentPresets.select(host.agent, preset);
        await host.ctx.sessionPersistence.flush();
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('UPDATE weft_session_config SET agent_document=? WHERE id=1', JSON.stringify(profile));
          this.ctx.storage.sql.exec('DELETE FROM weft_pending_preset WHERE id=1');
        });
        await this.ctx.storage.sync();
        await control.trackSession(owner, {id: scope.sessionId, title: host.ctx.sessionTitle.get(host.agent.session)?.title ?? '', agentId: profile.spec.id, revision: profile.revision, workspaceId: this.ctx.storage.sql.exec<{workspace_id: string}>('SELECT workspace_id FROM weft_session_config WHERE id=1').one().workspace_id, updatedAt: new Date().toISOString()});
        return selected;
      } finally {
        try {await host.dispose();}
        finally {if (this.nativeHost === host) {this.nativeHost = undefined; this.nativeHostPromise = undefined;}}
      }
    }));
    await this.getNativeHost(scope);
    await this.publishNativeSummary(scope);
    return value;
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
          if (stored?.presentation === 1) return {ok: false, requestId, error: {code: 'NATIVE_SESSION_REQUIRED', message: 'Use the native Session API for this session', status: 409}};
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
          const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, attachedWorkspace, persona, false, undefined, hooks);
          if (!stored) this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document) VALUES (1,?,?)', attachedWorkspace, profile ? JSON.stringify(profile) : null);
          if (profile) await controlFor(this.env, controlScope(scope.tenantId, scope.environmentId)).trackSession(controlScope(scope.tenantId, scope.environmentId), {
            id: scope.sessionId, title: text.slice(0, 80), agentId: profile.spec.id, revision: profile.revision, workspaceId: attachedWorkspace!, updatedAt: new Date().toISOString(),
          });
          timer = setTimeout(() => { controller.abort({ code: 'TURN_TIMEOUT', message: 'Turn deadline exceeded', status: 504 } satisfies TurnFailure); }, runtime.turnTimeoutMs);
          const events = await runHarnessTurn({
            ...runtime.options,
            signal: controller.signal,
            cancellationCause: () => controller.signal.reason?.code === 'TURN_TIMEOUT' ? {kind: 'hook', reason: 'turn-deadline'} : {kind: 'user'},
          }, text);
          return { ok: true, requestId, events, model: runtime.options.model };
        } catch (error) {
          return { ok: false, requestId, error: controller.signal.aborted ? controller.signal.reason as TurnFailure : turnFailure(error) };
        } finally { if (timer !== undefined) clearTimeout(timer); }
      });
    } finally {
      this.requests.delete(requestId);
    }
  }

  /** Native Web creation opens a real persisted Session before its first prompt. */
  async nativeCreate(input: SessionScope, binding?: AgentBinding, workspaceId?: string, cwd?: string): Promise<boolean> {
    const scope = this.assertScope(input);
    const known = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string; presentation: number}>('SELECT workspace_id,agent_document,presentation FROM weft_session_config WHERE id=1').toArray()[0];
    const existing = readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId));
    if (known && existing) {
      if (known.presentation !== 1 || existing.events.some(event => event.type === 'turn/start') || (workspaceId && workspaceId !== known.workspace_id) || (cwd && workspacePath(cwd) !== (existing.header.cwd ?? '/workspace'))) return false;
      const profile = JSON.parse(known.agent_document) as AgentRevision;
      try {await this.nativeSelectPreset(scope, binding?.id ?? profile.spec.id, binding?.revision ?? (binding ? undefined : profile.revision));}
      catch (error) {if (error instanceof RemoteError && error.code === 'agent-preset/locked') return false; throw error;}
      return true;
    }
    if (existing || known) return false;
    const result = await this.exclusive(async () => {
      if (this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1').toArray().length) return 'race' as const;
      if (readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) return false;
      const owner = controlScope(scope.tenantId, scope.environmentId);
      const control = controlFor(this.env, owner);
      const requested = binding?.id ?? (await control.nativePresetDefault(owner));
      const {value: profile} = await (await control.nativeProfile(owner, requested, binding?.revision)).json() as {value?: AgentRevision};
      if (!profile) throw new RemoteError('agent-preset/not-found', 'Unknown preset', {agentPreset: requested, available: await control.nativePresetIds(owner)});
      if (profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      const attachedWorkspace = workspaceId ?? profile.spec.workspaceId;
      workspaceIdSchema.parse(attachedWorkspace);
      const reader = await this.getReader();
      const directory = workspacePath(cwd ?? '/workspace');
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, attachedWorkspace, profile.spec.persona, true, reader, {}, directory, false);
      await initializeHarnessSession(runtime.options);
      this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document,presentation) VALUES (1,?,?,1) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,agent_document=excluded.agent_document,presentation=1', attachedWorkspace, JSON.stringify(profile));
      await control.trackSession(owner, {id: scope.sessionId, title: '', agentId: profile.spec.id, revision: profile.revision, workspaceId: attachedWorkspace, updatedAt: new Date().toISOString()});
      await this.publishNativeSummary(scope);
      return true;
    });
    return result === 'race' ? this.nativeCreate(scope, binding, workspaceId, cwd) : result;
  }

  async nativeHeader(input: SessionScope) {
    const scope = this.assertScope(input);
    if (!this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1 AND presentation=1').toArray().length) return undefined;
    return readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))?.header;
  }

  private async fileHost(input: SessionScope) {
    const scope = this.assertScope(input);
    const config = this.ctx.storage.sql.exec<{workspace_id: string}>('SELECT workspace_id FROM weft_session_config WHERE id=1 AND presentation=1 AND EXISTS (SELECT 1 FROM harness_sessions WHERE id=?)', scope.sessionId).toArray()[0];
    if (!config) {
      throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(scope.sessionId)});
    }
    const workspaceScope = {tenantId: scope.tenantId, environmentId: scope.environmentId ?? 'default', workspaceId: config.workspace_id};
    return createNativeFileHost(this.ctx.storage, workspaceScope, scope.sessionId, this.env.WORKSPACES.getByName(workspaceAddress(workspaceScope)));
  }

  async nativeFileCall(input: SessionScope, endpoint: NativeFileEndpoint, args: unknown, rpcId: string): Promise<Response> {
    const host = await this.fileHost(input);
    try {
      const response = await host.call(endpoint, args, rpcId);
      response.headers.set('cache-control', 'private, no-store');
      return response;
    } finally {await host.dispose();}
  }
  async nativeImageAttachment(input: SessionScope, attachmentId: string): Promise<Response> {
    const scope = this.assertScope(input);
    const snapshot = readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId));
    if (!snapshot) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(scope.sessionId)});
    const ref = referencedImage(snapshot.events, attachmentId);
    if (!ref) throw new RemoteError('session/attachment-invalid', 'Image is not referenced by this session.', {reason: 'ATTACHMENT_NOT_REFERENCED'});
    const reader = await this.getReader();
    try {
      const stored = await (reader.activeRuntime()?.ctx ?? reader.ctx).attachments.readImage(ref);
      return Response.json({value: {attachment: stored.ref, data: Buffer.from(stored.data).toString('base64')}});
    } catch (error) {
      if (error instanceof AttachmentError) throw new RemoteError('session/attachment-invalid', error.message, {reason: error.code});
      throw error;
    }
  }
  async nativeFileUpload(input: SessionScope, raw: unknown): Promise<Response> {
    const scope = this.assertScope(input);
    const method = uploadRemote.methods['fileUploads/upload'];
    const args = method.input({strict: true}).create().parse(raw);
    if (args.agentId !== scope.sessionId) throw new RemoteError('gateway/bad-request', 'Upload agent scope mismatch', {});
    const host = await this.getNativeHost(scope);
    const value = await host.ctx.fileUploads.upload(host.agent, args.request, new AbortController().signal);
    await this.ctx.storage.sync();
    return Response.json({value: method.result.create().parse(value)});
  }

  async nativeCancelFileObserver(input: SessionScope, observerId: string): Promise<void> {
    this.assertScope(input);
    z.uuid().parse(observerId);
    const stop = this.fileObservers.get(observerId);
    if (stop) await stop();
    else {
      for (const [id, expires] of this.cancelledFileObservers) if (expires < Date.now()) this.cancelledFileObservers.delete(id);
      if (this.cancelledFileObservers.size >= 64) this.cancelledFileObservers.delete(this.cancelledFileObservers.keys().next().value!);
      this.cancelledFileObservers.set(observerId, Date.now() + 30_000);
    }
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
    if (active?.ctx.get('sessionTitle')) {
      const value = await renameLiveHarnessSession(active.ctx, active.agent, title);
      await this.publishNativeSummary(scope);
      return value;
    }
    return this.exclusive(async () => {
      const stored = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string}>('SELECT workspace_id,agent_document FROM weft_session_config WHERE id=1').one();
      const profile = JSON.parse(stored.agent_document) as AgentRevision;
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, stored.workspace_id, profile.spec.persona, true, await this.getReader(), {}, this.nativeCwd(scope.sessionId));
      const value = await renameHarnessSession(runtime.options, title);
      await this.publishNativeSummary(scope);
      return value;
    });
  }

  async nativeStatus(input: SessionScope): Promise<NativeSummary | undefined> {
    const scope = this.assertScope(input);
    if (!this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1 AND presentation=1').toArray().length) return undefined;
    const row = this.ctx.storage.sql.exec<{header_json: string; event_count: number}>('SELECT header_json,event_count FROM harness_sessions WHERE id=?', scope.sessionId).toArray()[0];
    if (!row) return undefined;
    const header = JSON.parse(row.header_json) as import('@deepseek-ai/dsh-session').SessionHeader;
    const last = this.ctx.storage.sql.exec<{time: number}>("SELECT MAX(json_extract(event_json,'$.time')) AS time FROM harness_events WHERE session_id=? AND json_extract(event_json,'$.type')='user/message' AND json_extract(event_json,'$.data.source.kind')='user'", scope.sessionId).one();
    const turn = this.ctx.storage.sql.exec("SELECT seq FROM harness_events WHERE session_id=? AND json_extract(event_json,'$.type')='turn/start' LIMIT 1", scope.sessionId).toArray().length > 0;
    const active = this.readerPromise ? (await this.readerPromise).activeRuntime()?.agent : undefined;
    return {sessionId: header.id, updatedAt: last.time ?? header.createdAt, running: active?.status === 'running', agentAvailable: active !== undefined, blank: !turn, ...(header.cwd ? {cwd: header.cwd} : {}), formatStatus: 'current' as const};
  }

  async nativeSelectModel(input: SessionScope, raw: unknown): Promise<Response> {
    const scope = this.assertScope(input);
    const {request} = sessionRemote.methods['session/selectModel'].input({strict: true}).create().parse({request: raw});
    if (request.sessionId !== scope.sessionId) throw new Error('Session identity mismatch');
    if (!await this.nativeStatus(scope)) throw new RemoteError('session/not-found', 'Session not found', {sessionId: request.sessionId});
    const active = (await this.getReader()).activeRuntime();
    let value;
    if (active?.ctx.get('llm')) value = await selectLiveHarnessModel(active.ctx, active.agent, request);
    else value = await this.exclusive(async () => {
      const stored = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string}>('SELECT workspace_id,agent_document FROM weft_session_config WHERE id=1').one();
      const profile = JSON.parse(stored.agent_document) as AgentRevision;
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, stored.workspace_id, profile.spec.persona, true, await this.getReader(), {}, this.nativeCwd(scope.sessionId));
      return selectHarnessModel(runtime.options, request);
    });
    await this.publishNativeSummary(scope);
    const owner = controlScope(scope.tenantId, scope.environmentId);
    await controlFor(this.env, owner).nativeSaveDefaultModel(owner, value.selected);
    return Response.json(sessionRemote.methods['session/selectModel'].result.create().parse(value));
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
    try {
      for (let attempt = 0;; attempt++) {
        try {await (await this.getNativeHost(scope)).prompt(request); break;}
        catch (error) {if (!(error instanceof NativeHostReplacedError) || attempt >= 1) throw error;}
      }
      await this.ctx.storage.sync();
    } catch (error) {
      if (error instanceof ModelConfigurationError && error.code === 'MODEL_NOT_CONFIGURED') throw new RemoteError('session/provider-credentials-unavailable', error.message, {});
      throw error;
    }
  }

  async nativeUpdateQueue(input: SessionScope, raw: unknown): Promise<void> {
    const scope = this.assertScope(input);
    const {request} = sessionRemote.methods['session/updateQueue'].input({strict: true}).create().parse({request: raw});
    if (request.sessionId !== scope.sessionId) throw new Error('Session identity mismatch');
    if (!readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) throw new RemoteError('session/queue-item-not-found', 'Queued item is no longer pending', {itemId: request.itemId});
    await (await this.getNativeHost(scope)).updateQueue(request);
    await this.ctx.storage.sync();
  }

  async nativeCancel(input: SessionScope): Promise<void> {
    this.assertScope(input);
    if (this.nativeHost) this.nativeHost.cancel();
    else for (const id of this.requests.keys()) await this.cancel(input, id);
  }

  /** Trusted plugin lifecycle feedback uses the native durable inbox. */
  async nativePluginContext(input: SessionScope, text: string, wakeup: boolean): Promise<void> {
    const scope = this.assertScope(input);
    z.string().min(1).max(32_768).parse(text);
    z.boolean().parse(wakeup);
    await (await this.getNativeHost(scope)).deliver(createUserMessage({content: [{type: 'text', text}], source: {kind: 'cordis-host-runner'}}), wakeup);
    await this.ctx.storage.sync();
  }

  async nativePluginCall(input: SessionScope, endpoint: NativePluginEndpoint, raw: unknown): Promise<Response> {
    const scope = this.assertScope(input);
    if (!readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(scope.sessionId)});
    if (!Object.hasOwn(nativePluginRemote.methods, endpoint)) throw new RemoteError('gateway/method-unavailable', 'Unknown plugin method', {endpoint});
    const host = await this.getNativeHost(scope);
    return nativePlugins(host.ctx)!.invoke(endpoint, raw, host.agent);
  }
  async nativePluginManifest(input: SessionScope, providers: unknown): Promise<void> {
    this.assertScope(input);
    const args = nativePluginRemote.methods['dynamicCordisRunner/syncInspectManifest'].input({strict: true}).create().parse({providers});
    if (this.nativeHost) nativePlugins(this.nativeHost.ctx)!.runner.syncInspectManifest(args.providers);
  }
  async nativePluginFs(input: SessionScope, pluginId: string, runId: string, method: string, args: unknown[]): Promise<unknown> {
    const scope = this.assertScope(input);
    const host = this.nativeHost ?? await this.getNativeHost(scope);
    if (!nativePlugins(host.ctx)?.hasRun(pluginId, runId)) throw new Error('Plugin activation no longer owns this capability');
    if (!(nativePluginFsMethods as readonly string[]).includes(method)) throw new Error('Filesystem method is not bridged');
    const fs = host.ctx.get('fs');
    if (!fs) throw new Error('No filesystem is mounted');
    const fn = Reflect.get(fs, method);
    if (typeof fn !== 'function') throw new Error('Filesystem method is unavailable');
    return Reflect.apply(fn, fs, z.array(z.unknown()).max(5).parse(args));
  }

  /** Internal binding transport; external requests are authenticated by the entry Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === FILE_UPLOAD_PATH) {
      const scope = this.assertScope(scopeSchema.parse(JSON.parse(request.headers.get('x-weft-session-scope') ?? 'null')));
      if (new URL(request.url).searchParams.get('sessionId') !== scope.sessionId) throw new RemoteError('gateway/bad-request', 'Upload session scope mismatch', {});
      const host = await this.getNativeHost(scope);
      const response = await host.ctx.weftConnectionRoutes.dispatch(request);
      await this.ctx.storage.sync();
      return response;
    }
    const raw: unknown = await request.json();
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-file-changes') {
      const envelope = z.object({scope: scopeSchema, operation: z.literal('native-file-changes'), observerId: z.uuid(), args: z.unknown()}).strict().parse(raw);
      this.assertScope(envelope.scope);
      const cancelledUntil = this.cancelledFileObservers.get(envelope.observerId) ?? 0;
      this.cancelledFileObservers.delete(envelope.observerId);
      if (cancelledUntil > Date.now()) throw new RemoteError('gateway/bad-request', 'File observer was cancelled', {});
      if (this.fileObservers.size >= 32 || this.fileObservers.has(envelope.observerId)) throw new RemoteError('gateway/bad-request', 'File observer limit or duplicate identity', {});
      const abort = new AbortController();
      if (request.signal.aborted) abort.abort();
      else request.signal.addEventListener('abort', () => abort.abort(), {once: true});
      const pending = this.fileHost(envelope.scope);
      let closing: Promise<void> | undefined;
      let lease: ReturnType<typeof setTimeout> | undefined;
      const stop = () => closing ??= (async () => {
        clearTimeout(lease);
        abort.abort();
        try {await (await pending).dispose();}
        finally {this.fileObservers.delete(envelope.observerId);}
      })();
      this.fileObservers.set(envelope.observerId, stop);
      // The native stream supervisor reconnects with a fresh ready baseline.
      // Bound orphan lifetime even if a disconnected carrier loses cancellation.
      lease = setTimeout(() => this.ctx.waitUntil(stop()), 120_000);
      const host = await pending.catch(error => {clearTimeout(lease); this.fileObservers.delete(envelope.observerId); throw error;});
      try { return await host.changes(envelope.args, abort, stop); }
      catch (error) {await stop(); throw error;}
    }
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
    const native = await this.nativeHostPromise?.catch(() => undefined);
    await native?.whenIdle();
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
      const accessDenied = (code: string) => {
        console.warn('weft.access.denied', {path: pathname, code});
        return Response.json({error: 'Cloudflare Access user login required', code}, {status: 401, headers: {'cache-control': 'private, no-store'}});
      };
      if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return accessDenied('ACCESS_NOT_CONFIGURED');
      if (ctx.access && ctx.access.aud !== env.ACCESS_AUD) return accessDenied('ACCESS_AUDIENCE_MISMATCH');
      let assertionPrincipal;
      if (!ctx.access) {
        try {assertionPrincipal = await authenticateAccessAssertion(request, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN);}
        catch (error) {
          if (!(error instanceof AccessAssertionUnavailable)) throw error;
          console.warn('weft.access.assertion.unavailable', {path: pathname});
          return Response.json({error: 'Cloudflare Access verification is temporarily unavailable', code: 'ACCESS_ASSERTION_UNAVAILABLE'}, {status: 503, headers: {'cache-control': 'private, no-store'}});
        }
        if (!assertionPrincipal) return accessDenied('ACCESS_CONTEXT_MISSING');
        console.info('weft.access.assertion.accepted', {path: pathname});
      }
      // Assets contain no tenant state. Access already authenticated this invocation;
      // avoid an identity lookup for every concurrent module and font request.
      const ui = serveUi(request, env.UI);
      if (ui) {
        const response = await ui;
        if (response.status >= 400) console.warn('weft.ui.asset.failed', {path: pathname, status: response.status});
        return response;
      }
      let principal;
      try {principal = assertionPrincipal ?? await authenticateAccess(ctx.access, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN);}
      catch {
        console.warn('weft.access.identity.unavailable', {path: pathname});
        return Response.json({error: 'Cloudflare Access identity is temporarily unavailable', code: 'ACCESS_IDENTITY_UNAVAILABLE'}, {status: 503, headers: {'cache-control': 'private, no-store'}});
      }
      if (!principal) return accessDenied('ACCESS_USER_IDENTITY_MISSING');
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
