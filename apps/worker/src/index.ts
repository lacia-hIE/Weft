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
import {agentRemoteFor} from './agent-remotes.ts';
import {invokeAgentRemote, openRemoteStream} from '../../../packages/harness-runtime/src/remote-dispatch.ts';
import {UplinkQueue} from '../../../packages/harness-runtime/src/uplink.ts';
import {openPermissionWorld} from '../../../packages/native-environment/src/permissions.ts';
import {readScheduleCatalog, drainDueReminders} from '../../../packages/native-schedule/src/index.ts';
import questionRemote from '../../../.generated/official-remotes/packages/interaction/user-questions/typert.remote-client.js';
import {FILE_UPLOAD_PATH} from '@weft/upstream/packages/client/file-upload/src/protocol.ts';
import {CHANGED_FILES_PATH, CHANGES_DIFF_PATH} from '@weft/upstream/packages/client/ui-deliverables/src/changes.ts';
import { workspaceIdSchema, workspaceAddress, workspacePath } from '../../../packages/workspace/src/protocol.ts';
export { WorkspaceDO, TenantDO, EnvironmentDO };
// The shell Dynamic Worker reaches its own WorkspaceDO through this entrypoint (ctx.exports).
export { WorkspaceServiceProxy, WorkspaceProxy } from '@cloudflare/computer';
export { WorkspaceContainerBasicDO, WorkspaceContainerStandard1DO, WorkspaceContainerStandard2DO } from '../../../packages/workspace/src/container-host.ts';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-cordis-host-runner';
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import {readSessionReferenceMetadata} from '../../../packages/native-query/src/reference-metadata.ts';
import {WorkspaceSubprocess} from '../../../packages/workspace/src/subprocess.ts';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { runHarnessTurn, initializeHarnessSession, renameHarnessSession, renameLiveHarnessSession, selectHarnessModel } from '../../../packages/harness-runtime/src/runtime.ts';
import { selectLiveHarnessModel } from '../../../packages/harness-runtime/src/model-selection.ts';
import { NativeSessionHost, NativeHostReplacedError } from './native-session-host.ts';
import {replaceNativePreset, nativePresetDefinition} from '../../../packages/native-composition/src/index.ts';
import { NativePlugins, nativePlugins, type NativePluginEndpoint } from '../../../packages/native-plugins/src/host.ts';
import nativePluginRemote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import { nativePluginFsMethods } from '../../../packages/native-plugins/src/protocol.ts';
import { turnFailure, ModelConfigurationError, type ModelEnvironment, type TurnFailure } from '../../../packages/model-provider/src/index.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { initializeSessionStorage, SqliteSessionPersistence, readSessionSnapshot, readSessionMetadata, readSessionEventPage } from '../../../packages/session-persistence-do/src/index.ts';
import { authenticateAccess, sessionAddress, scopeSchema, type SessionScope } from '../../../packages/tenant/src/index.ts';
import {authenticateAccessAssertion, AccessAssertionUnavailable} from '../../../packages/tenant/src/access-assertion.ts';
import {subagentRemote, type SubagentEndpoint} from '../../../packages/native-subagents/src/protocol.ts';
import {nativeSessionList} from '../../../packages/harness-runtime/src/session-list.ts';
import process from 'node:process';

// Every environment volume is rooted at /workspace (the Remote Events host home),
// so the Harness and shared agent homes resolve inside the environment's own filesystem.
process.env.DSH_HOME ??= '/workspace/.dsh';
process.env.DSH_AGENTS_HOME ??= '/workspace/.agents';

export interface Env extends ModelEnvironment {
  LOADER?: WorkerLoader;
  IMAGES?: ImagesBinding;
  UI: Fetcher;
  SESSIONS: DurableObjectNamespace<SessionDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  TENANTS: DurableObjectNamespace<TenantDO>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDO>;
  /** Configuration plane (D1): environment settings and other non-secret configuration. */
  CONFIG_DB: D1Database;
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
/**
 * The original fork default (`session-controller/src/commands.ts`, module-private):
 * the latest completed-turn prefix, including standalone events before the next turn.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): number | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end');
  if (lastTurnEnd === undefined) return undefined;
  let boundary: number = lastTurnEnd.seq;
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append') || next.type === 'agent/inbox/spliced') break;
    boundary = next.seq;
  }
  return boundary;
}

export class SessionDO extends DurableObject<Env> {
  private readerPromise: Promise<Awaited<ReturnType<typeof createSessionReader>>> | undefined;
  private ownerScope: SessionScope | undefined;
  private readonly fileObservers = new Map<string, () => Promise<void>>();
  private readonly cancelledFileObservers = new Map<string, number>();
  /** The read world plus the permission projection fold of a private, Session-free permission service. */
  private async createReader(promote: (sessionId: SessionId) => void) {
    const reader = await createSessionReader(this.ctx.storage, promote);
    const scope = this.ownerScope;
    if (scope) {
      const owner = controlScope(scope.tenantId, scope.environmentId);
      const world = await openPermissionWorld(await controlFor(this.env, owner).nativePermissionDefault(owner));
      reader.registerProjections(world.definitions);
    }
    return reader;
  }
  private async getReader() {
    const reader = await (this.readerPromise ??= this.createReader(sessionId => {
      const scope = this.ownerScope;
      if (!scope || scope.sessionId !== sessionId) throw new Error('Root promotion address mismatch');
      this.ctx.waitUntil(this.getNativeHost(scope).then(() => {}).catch(async error => {
        const owner = controlScope(scope.tenantId, scope.environmentId);
        await controlFor(this.env, owner).nativeEvent(owner, 'api-session/error', [sessionId, turnFailure(error).message]);
      }));
    }));
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
      const host = await NativeSessionHost.open({...runtime.options, onEvent: (event, session) => {
        runtime.options.onEvent?.(event, session);
        // Titles can commit after the turn (the first-prompt LLM title row); list summaries follow them.
        if (event.type === 'session/title') this.ctx.waitUntil(this.publishNativeSummary(scope).catch(() => { /* The next turn or rename republishes. */ }));
      }, beforeAssembly: async () => {await pluginsReady.promise; await runtime.options.beforeAssembly?.();}, mountTools: async ctx => {
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
        failed: (failure, sessionId) => controlFor(this.env, owner).nativeEvent(owner, 'api-session/error', [sessionId ?? scope.sessionId, failure.message]),
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
    const {items} = await (await this.nativeSessionSummaries(scope)).json() as import('@deepseek-ai/dsh-api-session-controller/types').SessionListValue;
    const owner = controlScope(scope.tenantId, scope.environmentId);
    const control = controlFor(this.env, owner);
    // Calls on one stub arrive in the order they are made, so the events need no round trip each.
    await Promise.all(items.flatMap(row => [
      control.nativeEvent(owner, 'api-session/added', [row]),
      control.nativeEvent(owner, 'api-session/status', [row.sessionId, row.running]),
    ]));
  }
  async nativeSessionSummaries(input: SessionScope): Promise<Response> {
    const scope = this.assertScope(input);
    const status = await this.nativeStatus(scope);
    if (!status) return Response.json({items: []});
    const raw: unknown = await (await this.nativeProjections(scope)).json();
    const projections = sessionRemote.methods['session/projections'].result.create().parse(raw);
    const row = {...status, ...(projections?.kind === 'sequenced' ? {projections: {kind: 'sequenced' as const, asOfSeq: projections.asOfSeq, values: projections.values}} : {})};
    const reader = await this.getReader();
    const children = (await nativeSessionList(reader.activeRuntime()?.ctx ?? reader.ctx).list()).filter(item => item.origin === 'subagent');
    return Response.json(sessionRemote.methods['session/list'].result.create().parse({items: [row, ...children]}));
  }
  async nativeWorkspaceActivity(input: SessionScope): Promise<Response> {
    const scope = this.assertScope(input);
    const reader = await this.getReader();
    const ctx = this.nativeHost?.ctx ?? reader.activeRuntime()?.ctx ?? reader.ctx;
    return Response.json(await ctx.waterfall('workspace/session-activity', {sessionId: SessionId(scope.sessionId)}, () => Promise.resolve([])));
  }
  async nativeWorkspaceStop(input: SessionScope): Promise<void> {
    const scope = this.assertScope(input);
    const reader = await this.getReader();
    const ctx = this.nativeHost?.ctx ?? reader.activeRuntime()?.ctx ?? reader.ctx;
    await ctx.parallel('workspace/session-stop', {sessionId: SessionId(scope.sessionId)});
    await ctx.sessionPersistence.flush();
  }
  /** Stop live container handles without opening a cold Agent or changing schedules. */
  async nativeStopContainerProcesses(input: SessionScope, workspaceId: string): Promise<void> {
    this.assertScope(input);
    const configured = this.ctx.storage.sql.exec<{workspace_id: string}>('SELECT workspace_id FROM weft_session_config WHERE id=1').toArray()[0];
    if (configured?.workspace_id !== workspaceId) return;
    const runtime = this.nativeHost ?? (this.readerPromise ? (await this.readerPromise).activeRuntime() : undefined);
    if (!runtime) return;
    const subprocess = runtime.ctx.get('subprocess');
    if (!(subprocess instanceof WorkspaceSubprocess)) return;
    if (subprocess.hasContainerActivity()) for (const agent of runtime.ctx.agents.list()) {
      if (agent.status === 'running') agent.cancel({kind: 'user'});
    }
    await subprocess.stopContainerProcesses();
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
    // Take the host's queue on arrival, so a prompt sent after this selection cannot start the turn first.
    const value = await host.reconfigureBlank(preset, () => this.exclusive(async () => {
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
      // Without a binding the environment resolves its default preset in the same call.
      const {value: profile} = await (await control.nativeProfile(owner, binding?.id, binding?.revision)).json() as {value?: AgentRevision};
      if (!profile) throw new RemoteError('agent-preset/not-found', 'Unknown preset', {agentPreset: binding?.id ?? await control.nativePresetDefault(owner), available: await control.nativePresetIds(owner)});
      if (profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      const attachedWorkspace = workspaceId ?? profile.spec.workspaceId;
      workspaceIdSchema.parse(attachedWorkspace);
      const reader = await this.getReader();
      const directory = workspacePath(cwd ?? '/workspace');
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, profile, attachedWorkspace, profile.spec.persona, true, reader, {}, directory, false);
      await initializeHarnessSession(runtime.options);
      this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document,presentation) VALUES (1,?,?,1) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,agent_document=excluded.agent_document,presentation=1', attachedWorkspace, JSON.stringify(profile));
      await Promise.all([
        control.trackSession(owner, {id: scope.sessionId, title: '', agentId: profile.spec.id, revision: profile.revision, workspaceId: attachedWorkspace, updatedAt: new Date().toISOString()}),
        this.publishNativeSummary(scope),
      ]);
      return true;
    });
    return result === 'race' ? this.nativeCreate(scope, binding, workspaceId, cwd) : result;
  }

  /** The original fork seed for a Session this object owns; the default boundary is the latest completed turn. */
  async nativeForkSeed(input: SessionScope, sessionId: string, atSeq?: number): Promise<Response> {
    const scope = this.assertScope(input);
    try {
      await this.assertNativeLogicalOwner(scope, sessionId);
      await this.nativeHost?.ctx.sessionPersistence.flush();
      const stored = this.ctx.storage.sql.exec<{workspace_id: string; agent_document: string}>('SELECT workspace_id,agent_document FROM weft_session_config WHERE id=1 AND presentation=1').toArray()[0];
      const snapshot = readSessionSnapshot(this.ctx.storage, SessionId(sessionId));
      if (!stored || !snapshot) throw new RemoteError('session/not-found', `session "${sessionId}" not found`, {sessionId: SessionId(sessionId)});
      const boundary = atSeq ?? latestCompletedPrefixBoundary(snapshot.events);
      if (boundary === undefined || snapshot.events[boundary]?.seq !== boundary) {
        throw new RemoteError('session/fork-unavailable', atSeq === undefined
          ? `session "${sessionId}" has no completed turn to fork from`
          : `event ${String(atSeq)} does not exist in session "${sessionId}" (last seq: ${String(snapshot.events.at(-1)?.seq ?? 'none')})`, {sessionId: SessionId(sessionId)});
      }
      return Response.json({ok: true, value: {events: buildForkSeed(snapshot.events, SessionSeq(boundary)), inherited: boundary + 1, cwd: snapshot.header.cwd ?? '/workspace', workspaceId: stored.workspace_id, profile: JSON.parse(stored.agent_document) as AgentRevision}});
    } catch (error) {
      const failure = remoteErrorOf(error);
      if (!failure) throw error;
      return Response.json({ok: false, error: failure});
    }
  }

  /** Create this object's Session from a fork seed, as the original controller's `agents.create({seed})`. */
  async nativeCreateFork(input: SessionScope, fork: {events: SessionEvent[]; inherited: number; parentSession: string; cwd: string; workspaceId: string; profile: AgentRevision}): Promise<void> {
    const scope = this.assertScope(input);
    await this.exclusive(async () => {
      if (this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1').toArray().length || readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) throw new RemoteError('gateway/internal', 'Fork Session identity was already used', {});
      if (fork.profile.upstream !== upstream.commit) throw new Error('Agent runtime revision unavailable');
      workspaceIdSchema.parse(fork.workspaceId);
      const directory = workspacePath(fork.cwd);
      const runtime = await sessionRuntime(this.env, this.ctx.storage, scope, fork.profile, fork.workspaceId, fork.profile.spec.persona, true, await this.getReader(), {}, directory, false);
      await initializeHarnessSession({...runtime.options, seed: {events: fork.events, inherited: fork.inherited}, meta: {...runtime.options.meta, parentSession: fork.parentSession, isSeeded: true}});
      this.ctx.storage.sql.exec('INSERT INTO weft_session_config (id,workspace_id,agent_document,presentation) VALUES (1,?,?,1)', fork.workspaceId, JSON.stringify(fork.profile));
      const owner = controlScope(scope.tenantId, scope.environmentId);
      await controlFor(this.env, owner).trackSession(owner, {id: scope.sessionId, title: '', agentId: fork.profile.spec.id, revision: fork.profile.revision, workspaceId: fork.workspaceId, updatedAt: new Date().toISOString()});
      await this.publishNativeSummary(scope);
    });
  }

  async nativeHeader(input: SessionScope) {
    const scope = this.assertScope(input);
    if (!this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1 AND presentation=1').toArray().length) return undefined;
    return readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))?.header;
  }

  async nativeSearchMetadata(input: SessionScope, sessionId = input.sessionId) {
    const scope = this.assertScope(input);
    await this.assertNativeLogicalOwner(scope, sessionId);
    if (!this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1 AND presentation=1').toArray().length) return undefined;
    return readSessionMetadata(this.ctx.storage, SessionId(sessionId));
  }

  async nativeSearchPage(input: SessionScope, offset: number, end: number, sessionId = input.sessionId): Promise<Response> {
    const scope = this.assertScope(input);
    await this.assertNativeLogicalOwner(scope, sessionId);
    if (!this.ctx.storage.sql.exec('SELECT id FROM weft_session_config WHERE id=1 AND presentation=1').toArray().length) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(scope.sessionId)});
    return Response.json({events: readSessionEventPage(this.ctx.storage, SessionId(sessionId), offset, end)});
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
  async nativeImageAttachment(input: SessionScope, attachmentId: string, sessionId = input.sessionId): Promise<Response> {
    const scope = this.assertScope(input);
    await this.assertNativeLogicalOwner(scope, sessionId);
    const snapshot = readSessionSnapshot(this.ctx.storage, SessionId(sessionId));
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
    await this.assertNativeHistoryOwner(scope, request.address);
    return Response.json(await (await this.getReader()).history.page(request, new AbortController().signal));
  }

  private async assertNativeHistoryOwner(scope: SessionScope, address: {kind: 'session'; sessionId: string} | {kind: 'subagent'; parentSessionId: string; childSessionId: string}): Promise<void> {
    if (address.kind === 'session') {
      if (address.sessionId !== scope.sessionId) throw new Error('Session address mismatch');
    } else {
      const owner = controlScope(scope.tenantId, scope.environmentId);
      if (await controlFor(this.env, owner).nativeSessionRoot(owner, address.parentSessionId) !== scope.sessionId) throw new RemoteError('subagent/unauthorized', 'Parent is outside this session owner', {childSessionId: SessionId(address.childSessionId)});
    }
  }

  private async invokeSubagent(input: SessionScope, endpoint: SubagentEndpoint, raw: unknown, signal: AbortSignal) {
    const scope = this.assertScope(input);
    if (!Object.hasOwn(subagentRemote.methods, endpoint)) throw new RemoteError('gateway/method-unavailable', 'Unknown subagent method', {endpoint});
    const method = subagentRemote.methods[endpoint];
    if (endpoint === 'subagents/prompt') {
      const args = subagentRemote.methods[endpoint].input({strict: true}).create().parse(raw);
      await this.assertNativeHistoryOwner(scope, {kind: 'subagent', parentSessionId: args.request.parentSessionId, childSessionId: args.request.childSessionId});
      const host = await this.getNativeHost(scope);
      const value = await host.ctx.subagents.prompt(args.request, signal);
      await host.ctx.sessionPersistence.flush();
      return method.result.create().parse(value);
    }
    const args = subagentRemote.methods['subagents/interruptByParent'].input({strict: true}).create().parse(raw);
    await this.assertNativeHistoryOwner(scope, {kind: 'subagent', parentSessionId: args.parentSessionId, childSessionId: args.childSessionId});
    // Preserve native interrupt semantics: a cold or settled target is a no-op.
    const service = this.nativeHost?.ctx.subagents ?? (await this.getReader()).ctx.subagents;
    const value = service.interruptByParent(args.childSessionId, args.parentSessionId, args.mode);
    return method.result.create().parse(value);
  }

  private async assertNativeLogicalOwner(scope: SessionScope, sessionId: string): Promise<void> {
    if (sessionId === scope.sessionId) return;
    const owner = controlScope(scope.tenantId, scope.environmentId);
    if (await controlFor(this.env, owner).nativeSessionRoot(owner, sessionId) !== scope.sessionId) throw new RemoteError('subagent/unauthorized', 'Session is outside this owner', {childSessionId: SessionId(sessionId)});
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

  async nativeProjections(input: SessionScope, sessionId = input.sessionId): Promise<Response> {
    const scope = this.assertScope(input);
    await this.assertNativeLogicalOwner(scope, sessionId);
    if (!this.ctx.storage.sql.exec('SELECT id FROM harness_sessions WHERE id=?', sessionId).toArray().length) return Response.json(null);
    using observation = await (await this.getReader()).ctx.sessionQuery.observeSession(SessionId(sessionId));
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
  /** Schedule reminders wake the native root; the original runtime delivers what is due. */
  override async alarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='weft_alarm_scope'").toArray().length
      ? this.ctx.storage.sql.exec<{scope: string}>('SELECT scope FROM weft_alarm_scope WHERE id=1').toArray()[0] : undefined;
    if (!row) return;
    const scope = this.assertScope(JSON.parse(row.scope) as SessionScope);
    const host = await this.getNativeHost(scope);
    await drainDueReminders(host.ctx);
  }

  async nativeScheduleCatalog(input: SessionScope): Promise<unknown[]> {
    this.assertScope(input);
    const live = this.nativeHost?.ctx.get('schedule');
    return live ? live.catalog() : readScheduleCatalog(this.ctx.storage);
  }

  private readonly uplinks = new Map<string, UplinkQueue>();
  private uplink(streamId: string): UplinkQueue {
    let queue = this.uplinks.get(streamId);
    if (!queue) {
      if (this.uplinks.size >= 64) throw new RemoteError('gateway/bad-request', 'Too many open stream uplinks', {});
      queue = new UplinkQueue(() => { this.uplinks.delete(streamId); });
      this.uplinks.set(streamId, queue);
    }
    return queue;
  }
  /** Ordered client messages for one open bidirectional Remote stream on this object. */
  async nativeStreamInput(input: SessionScope, streamId: string, items: unknown[], end: boolean): Promise<void> {
    this.assertScope(input);
    z.uuid().parse(streamId);
    this.uplink(streamId).push(z.array(z.unknown()).max(64).parse(items), z.boolean().parse(end));
  }

  /** Official Agent-scoped Remote methods run on this DO's native root with the gateway's direct binding. */
  async nativeAgentRemote(input: SessionScope, endpoint: string, raw: unknown): Promise<Response> {
    const scope = this.assertScope(input);
    try {
      const info = agentRemoteFor(endpoint);
      if (!info) throw new RemoteError('gateway/method-unavailable', 'Remote method is not connected yet', {endpoint});
      if (!readSessionSnapshot(this.ctx.storage, SessionId(scope.sessionId))) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(scope.sessionId)});
      const host = await this.getNativeHost(scope);
      const value = await invokeAgentRemote(host.ctx, info, endpoint, raw, new AbortController().signal);
      await host.ctx.sessionPersistence.flush();
      await this.ctx.storage.sync();
      return Response.json({ok: true, ...(value === undefined ? {} : {value})});
    } catch (error) {
      const failure = remoteErrorOf(error);
      if (!failure) throw error;
      return Response.json({ok: false, error: failure});
    }
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
    const pathname = new URL(request.url).pathname;
    if (pathname === FILE_UPLOAD_PATH || pathname === CHANGED_FILES_PATH || pathname === CHANGES_DIFF_PATH) {
      const scope = this.assertScope(scopeSchema.parse(JSON.parse(request.headers.get('x-weft-session-scope') ?? 'null')));
      if (new URL(request.url).searchParams.get('sessionId') !== scope.sessionId) throw new RemoteError('gateway/bad-request', 'Session route scope mismatch', {});
      // A change summary lives in the running Session's recorder; a Session that is not running has none to serve.
      if (pathname !== FILE_UPLOAD_PATH && !this.nativeHost) return new Response('Change summary unavailable.', {status: 404, headers: {'cache-control': 'no-store'}});
      const host = await this.getNativeHost(scope);
      const response = await host.ctx.weftConnectionRoutes.dispatch(request);
      if (pathname === FILE_UPLOAD_PATH) await this.ctx.storage.sync();
      return response;
    }
    const raw: unknown = await request.json();
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-subagent') {
      const body = z.object({scope: scopeSchema, operation: z.literal('native-subagent'), endpoint: z.enum(['subagents/prompt', 'subagents/interruptByParent']), args: z.unknown()}).strict().parse(raw);
      this.assertScope(body.scope);
      try {return Response.json({ok: true, value: await this.invokeSubagent(body.scope, body.endpoint, body.args, request.signal)});}
      catch (error) {
        const failure = request.signal.aborted ? {code: 'gateway/cancelled', message: 'Subagent request cancelled', details: {}} : remoteErrorOf(error) ?? {code: 'gateway/internal', message: 'Subagent operation failed', details: {}};
        return Response.json({ok: false, error: {isDSHRemoteError: true, code: failure.code, message: failure.message, details: failure.details}});
      }
    }
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && (raw.operation === 'native-search-metadata' || raw.operation === 'native-reference-metadata' || raw.operation === 'native-search-page')) {
      const envelope = z.discriminatedUnion('operation', [
        z.object({scope: scopeSchema, sessionId: id.optional(), operation: z.literal('native-search-metadata')}).strict(),
        z.object({scope: scopeSchema, sessionId: id.optional(), operation: z.literal('native-reference-metadata')}).strict(),
        z.object({scope: scopeSchema, sessionId: id.optional(), operation: z.literal('native-search-page'), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict(),
      ]).parse(raw);
      this.assertScope(envelope.scope);
      request.signal.throwIfAborted();
      if (envelope.operation === 'native-reference-metadata') {
        const sessionId = envelope.sessionId ?? envelope.scope.sessionId;
        const metadata = await this.nativeSearchMetadata(envelope.scope, sessionId);
        return Response.json({value: metadata ? await readSessionReferenceMetadata(this.ctx.storage, sessionId, request.signal) : undefined});
      }
      return envelope.operation === 'native-search-metadata'
        ? Response.json({value: await this.nativeSearchMetadata(envelope.scope, envelope.sessionId ?? envelope.scope.sessionId)})
        : this.nativeSearchPage(envelope.scope, envelope.offset, envelope.end, envelope.sessionId ?? envelope.scope.sessionId);
    }
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
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-agent-stream') {
      const envelope = z.object({scope: scopeSchema, operation: z.literal('native-agent-stream'), endpoint: z.string(), args: z.unknown(), streamId: z.uuid().optional()}).strict().parse(raw);
      const scope = this.assertScope(envelope.scope);
      const info = agentRemoteFor(envelope.endpoint);
      if (!info) throw new RemoteError('gateway/method-unavailable', 'Remote stream is not connected yet', {endpoint: envelope.endpoint});
      const abort = new AbortController();
      if (request.signal.aborted) abort.abort(request.signal.reason);
      request.signal.addEventListener('abort', () => abort.abort(), {once: true});
      const host = await this.getNativeHost(scope);
      const uplink = envelope.streamId ? this.uplink(envelope.streamId) : undefined;
      uplink?.claim();
      abort.signal.addEventListener('abort', () => { if (envelope.streamId) {uplink?.end(); this.uplinks.delete(envelope.streamId);} }, {once: true});
      const stream = openRemoteStream(host.ctx, info, envelope.endpoint, envelope.args, abort.signal, uplink);
      return remoteStream(stream.items, abort, stream.parse, () => { if (envelope.streamId) {uplink?.end(); this.uplinks.delete(envelope.streamId);} });
    }
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-question-wait') {
      const envelope = z.object({scope: scopeSchema, operation: z.literal('native-question-wait'), args: z.unknown()}).strict().parse(raw);
      const scope = this.assertScope(envelope.scope);
      const method = questionRemote.methods['userQuestions/attachWait'];
      const args = method.input({strict: true}).create().parse(envelope.args);
      const abort = new AbortController();
      if (request.signal.aborted) abort.abort(request.signal.reason);
      request.signal.addEventListener('abort', () => abort.abort(), {once: true});
      const host = await this.getNativeHost(scope);
      const agent = host.ctx.agents.get(SessionId(args.agentId));
      if (!agent) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(args.agentId)});
      const codec = method.result.create();
      return remoteStream(host.ctx.userQuestions.attachWait(agent, args.callId, abort.signal), abort, value => codec.parse(value));
    }
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-follow') {
      const envelope = z.object({scope: scopeSchema, operation: z.literal('native-follow'), args: z.unknown()}).strict().parse(raw);
      const scope = this.assertScope(envelope.scope);
      const args = sessionRemote.methods['session/follow'].input({strict: true}).create().parse(envelope.args);
      await this.assertNativeHistoryOwner(scope, args.request.address);
      const abort = new AbortController();
      if (request.signal.aborted) abort.abort(request.signal.reason);
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
        return Response.json({ status: 'ok', mode: 'harness', backend: 'deepseek' });
      }
      const environment = await resolveEnvironmentRequest(request, env, principal);
      if (environment.response) return environment.response;
      request = environment.request;
      pathname = new URL(request.url).pathname;
      const nativeStarted = Date.now();
      const nativeResponse = await handleNativeRequest(request, env, principal, environment.environmentId);
      // Slow native calls name their method, so a latency report maps to the server step behind it.
      const nativeMs = Date.now() - nativeStarted;
      if (nativeMs >= 1000 && pathname.includes('/native/api/')) console.info('weft.native.slow', {method: pathname.replace(/^.*\/native\/api\//, ''), ms: nativeMs});
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
