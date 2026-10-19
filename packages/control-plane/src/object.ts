import { DurableObject } from "cloudflare:workers";
import {
  environmentCreateSchema,
  environmentScopeSchema,
  type ControlScope,
  type EnvironmentScope,
  type EnvironmentRecord,
  agentSchema,
  clientPluginSchema,
  id,
  type AgentRevision,
  type ClientPlugin,
  type SessionRecord,
  type TenantState,
} from "./contracts.ts";
import { validatePlugins } from "../../plugin-runtime/src/catalog.ts";
import { compileClientPlugin } from "../../client-plugins/src/compiler.ts";
import upstream from "../../../upstream.lock.json";
import { z } from 'zod';
import { NativeEventHub, NativeStreamHub } from './native-events.ts';
import { NativeWorkspaces } from './native-workspaces.ts';
import type { WorkspaceDO } from '../../workspace/src/object.ts';
import type { SessionDO } from '../../../apps/worker/src/index.ts';
import { workspaceAddress } from '../../workspace/src/protocol.ts';
import { sessionAddress, type SessionScope } from '../../tenant/src/index.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import type { SessionControlFrame, SessionProjectionBaseline } from '@deepseek-ai/dsh-api-session-controller/types';
import { remoteStream } from '../../harness-runtime/src/remote-stream.ts';
import { NativeSettings, PRESET_NAMESPACE, LOOP_NAMESPACE, SUBAGENT_NAMESPACE } from './native-settings.ts';
import {readNativePresets, type CompositionEndpoint} from '../../native-composition/src/profile-host.ts';
import {profileDefinitions} from '../../harness-profile/src/index.ts';
import {manageNativePlugins} from '../../native-composition/src/manager.ts';
import {mountWorkspace} from '../../workspace/src/provider.ts';
import { ModelConfigurationError, type ModelEnvironment } from '../../model-provider/src/index.ts';
import {SqliteModelUploadIndex, type ModelUploadOperation} from '../../model-provider/src/files-protocol.ts';
import { DATA_LAYOUT_VERSION } from '../../tenant/src/layout.ts';
import { NativePluginCatalog } from './native-plugins.ts';
import {NativeSessionSearch} from '../../native-query/src/host.ts';
import {mapConcurrent} from '../../native-query/src/concurrent.ts';
import {remoteErrorOf} from '@deepseek-ai/dsh-typert-protocol';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {SessionReadMetadata} from '../../session-persistence-do/src/index.ts';

declare const WEFT_VALIDATION_BUILD: boolean;

export interface TenantEnvironment extends ModelEnvironment {
  TENANTS: DurableObjectNamespace<TenantDO>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: DurableObjectNamespace<SessionDO>;
}
export const tenantAddress = (tenantId: string): string =>
  JSON.stringify([DATA_LAYOUT_VERSION, "tenant", id.parse(tenantId)]);

/** Environment-local Harness configuration, revisions and discoverable sessions. */
abstract class HarnessStateDO extends DurableObject<TenantEnvironment> {
  private nativeSearch: NativeSessionSearch | undefined;
  private sessionSearch(scope: ControlScope): NativeSessionSearch {
    this.scope(scope);
    if (this.nativeSearch) return this.nativeSearch;
    const target = (sessionId: string) => {
      const address: SessionScope = {...scope, sessionId: id.parse(this.nativeSessionRoot(scope, sessionId) ?? sessionId)};
      return {scope: address, stub: this.env.SESSIONS.getByName(sessionAddress(address))};
    };
    return this.nativeSearch = new NativeSessionSearch(this.ctx.storage, {
      ids: async signal => {
        signal?.throwIfAborted();
        return [...(await this.sessionIndex(scope)).map(record => record.id), ...this.ctx.storage.sql.exec<{id: string}>('SELECT id FROM native_child_owners ORDER BY id').toArray().map(row => row.id)];
      },
      metadata: async (sessionId, signal) => {
        signal?.throwIfAborted(); const session = target(sessionId);
        const value = await (await session.stub.fetch(new Request('https://session.internal/native-search-metadata', {
          method: 'POST', body: JSON.stringify({scope: session.scope, sessionId, operation: 'native-search-metadata'}), ...(signal ? {signal} : {}),
        }))).json() as {value?: SessionReadMetadata};
        signal?.throwIfAborted(); return value.value;
      },
      page: async (sessionId, offset, end, signal) => {
        signal?.throwIfAborted(); const session = target(sessionId);
        const value = await (await session.stub.fetch(new Request('https://session.internal/native-search-page', {
          method: 'POST', body: JSON.stringify({scope: session.scope, sessionId, operation: 'native-search-page', offset, end}), ...(signal ? {signal} : {}),
        }))).json() as {events: SessionEvent[]};
        signal?.throwIfAborted(); return value.events;
      },
    });
  }
  private modelUploads: SqliteModelUploadIndex | undefined;
  async nativeModelFiles(scope: ControlScope, operation: ModelUploadOperation): Promise<Response> {
    this.scope(scope);
    const value = (this.modelUploads ??= new SqliteModelUploadIndex(this.ctx.storage)).execute(operation);
    await this.ctx.storage.sync();
    return Response.json({value}, {headers: {'cache-control': 'private, no-store'}});
  }
  private nativePluginCatalog: NativePluginCatalog | undefined;
  private pluginCatalog(scope: ControlScope) {this.scope(scope); return this.nativePluginCatalog ??= new NativePluginCatalog(this.ctx.storage);}
  async nativeSyncPlugins(scope: ControlScope, sessionId: string, inventory: unknown, pending: unknown): Promise<void> {id.parse(sessionId); await this.pluginCatalog(scope).sync(sessionId, inventory, pending);}
  async nativePluginInventory(scope: ControlScope): Promise<Response> {return Response.json({value: this.pluginCatalog(scope).inventory()});}
  async nativePluginOwner(scope: ControlScope, kind: 'plugin' | 'approval' | 'inspect', resourceId: string): Promise<string | undefined> {return this.pluginCatalog(scope).owner(kind, resourceId);}
  async nativePluginManifest(scope: ControlScope): Promise<Response> {return Response.json({value: this.pluginCatalog(scope).manifest()});}
  async nativeSetPluginManifest(scope: ControlScope, providers: unknown): Promise<string[]> {const catalog = this.pluginCatalog(scope); await catalog.setManifest(providers); return catalog.sessions();}
  async nativePluginEvent(scope: ControlScope, sessionId: string, name: string, args: readonly unknown[]): Promise<void> {
    const catalog = this.pluginCatalog(scope);
    if (!['cordis/request-run', 'cordis/request-run-resolved', 'cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/inspect-query'].includes(name)) throw new Error('Unknown native plugin event');
    await catalog.event(sessionId, name, args);
    this.nativeEvents.emit(name, args);
  }
  private nativeSettings: NativeSettings | undefined;
  private settings(scope: ControlScope): NativeSettings {
    this.scope(scope);
    this.ensureDefault();
    this.ensureNativePresets();
    return this.nativeSettings ??= new NativeSettings(this.ctx.storage, {
      providerBase: () => ({baseURL: 'https://api.deepseek.com/anthropic', maxTokens: 8192, thinking: 'disabled', reasoningEffort: 'off', streamIdleTimeoutMs: 60_000, retryPolicy: {mode: 'normal', maxRetries: 0}, apiKeyEnv: 'DEEPSEEK_API_KEY'}),
      modelBase: () => WEFT_VALIDATION_BUILD && this.env.MODEL_BACKEND === 'scripted'
        ? {provider: 'validation', model: 'scripted'}
        : {provider: 'deepseek-official', model: this.latest('default')?.spec.model?.name ?? 'deepseek-flash'},
      changed: (event, args) => {
        this.nativeEvents.emit(event, args);
        if (event === 'settings/document-updated' && args[0] === PRESET_NAMESPACE) this.nativeEvents.emit('plugin-manager/changed', [{reason: 'plugin'}]);
      },
      validatePreset: id => {const value = this.latest(id); if (!value || value.spec.disabled) throw new Error('Unknown preset');},
    });
  }
  async nativeSettingsRequest(scope: ControlScope, endpoint: string, args: unknown): Promise<Response> {
    return this.settings(scope).invoke(endpoint, args);
  }
  private presetDefault(scope: ControlScope): string {
    const value = this.settings(scope).value(PRESET_NAMESPACE);
    return String(value.selectedDefault ?? value.default);
  }
  async nativePresetDefault(scope: ControlScope): Promise<string> {return this.presetDefault(scope);}
  async nativeLoopConfiguration(scope: ControlScope): Promise<Response> {
    return Response.json(this.settings(scope).value(LOOP_NAMESPACE));
  }
  async nativeSubagentConfiguration(scope: ControlScope): Promise<Response> {
    return Response.json(this.settings(scope).value(SUBAGENT_NAMESPACE));
  }
  async nativeProfile(scope: ControlScope, preset: string, revision?: number): Promise<Response> {
    this.scope(scope); this.ensureDefault(); this.ensureNativePresets();
    const value = await this.agent(scope, preset, revision);
    return Response.json({value: value?.spec.disabled ? undefined : value});
  }
  async nativePresetIds(scope: ControlScope): Promise<string[]> {return (await this.state(scope)).agents.filter(row => !row.spec.disabled).map(row => row.spec.id);}
  async nativePreset(scope: ControlScope, endpoint: CompositionEndpoint, args: unknown): Promise<Response> {
    const defaultId = await this.nativePresetDefault(scope);
    const profiles = (await this.state(scope)).agents;
    const volume = {...scope, workspaceId: 'default'};
    return readNativePresets(profiles, defaultId, endpoint, args, ctx => mountWorkspace(ctx, {scope: volume, transport: this.env.WORKSPACES.getByName(workspaceAddress(volume)), cwd: '/workspace'}));
  }
  async nativeManagePlugins(scope: ControlScope, endpoint: string, raw: unknown): Promise<Response> {
    this.scope(scope); this.ensureDefault(); this.ensureNativePresets();
    return manageNativePlugins({
      profiles: async () => (await this.state(scope)).agents,
      defaultPreset: () => this.nativePresetDefault(scope),
      publish: (spec, revision) => this.publishAgent(scope, spec, revision),
    }, endpoint, raw);
  }
  /** Private binding only: never dispatch this snapshot as a client Remote. */
  async nativeModelConfiguration(scope: ControlScope): Promise<Response> {
    this.scope(scope);
    try { return Response.json(await this.settings(scope).modelConfiguration()); }
    catch (error) { return Response.json({code: error instanceof ModelConfigurationError ? error.code : 'MODEL_CONFIGURATION_INVALID'}, {status: 503}); }
  }
  async nativeSaveDefaultModel(scope: ControlScope, selected: {provider: string; model: string; reasoningEffort?: string}): Promise<void> {
    await this.settings(scope).saveDefault(selected);
  }
  private readonly nativeEvents = new NativeEventHub();
  private readonly nativeControl = new NativeStreamHub<SessionControlFrame>();
  private nativeWorkspaces: NativeWorkspaces | undefined;
  private workspaces(scope: ControlScope): NativeWorkspaces {
    this.scope(scope);
    if (this.nativeWorkspaces) return this.nativeWorkspaces;
    const owner = scope;
    const session = (sessionId: string) => {
      const address: SessionScope = {...owner, sessionId};
      return {scope: address, stub: this.env.SESSIONS.getByName(sessionAddress(address))};
    };
    const volume = {...owner, workspaceId: 'default'};
    return this.nativeWorkspaces = new NativeWorkspaces(this.ctx.storage, {
      files: operation => this.env.WORKSPACES.getByName(workspaceAddress(volume)).call(volume, operation),
      header: async id => {const target=session(id); return target.stub.nativeHeader(target.scope);},
      headers: async () => {
        const records = await this.sessionIndex(scope);
        const values = await mapConcurrent(records, async row => {const target=session(row.id); return target.stub.nativeHeader(target.scope);});
        return values.filter(value => value !== undefined);
      },
      activity: async id => {const target=session(id); return await (await target.stub.nativeWorkspaceActivity(target.scope)).json() as import('@deepseek-ai/dsh-workspace/types').SessionActivity[];},
      stop: async id => {const target=session(id); await target.stub.nativeWorkspaceStop(target.scope);},
    });
  }
  async nativeWorkspace(scope: ControlScope, endpoint: string, args: unknown): Promise<Response> {
    const catalog = this.workspaces(scope);
    try {
      if (endpoint === 'workspace/initializeDefault') {
        z.object({}).strict().parse(args);
        const workspace = await catalog.initializeDefault();
        return Response.json({value: workspace ? {workspace} : undefined});
      }
      return await catalog.invoke(endpoint, args);
    } catch (error) {
      const failure = remoteErrorOf(error) ?? (error instanceof z.ZodError ? {code: 'gateway/bad-request', message: 'Invalid workspace arguments', details: {}} : undefined);
      if (!failure) throw error;
      return Response.json({error: {isDSHRemoteError: true, code: failure.code, message: failure.message, details: failure.details}});
    }
  }
  async nativeResolveWorkspace(scope: ControlScope, workspaceId?: string, cwd?: string) {
    return this.workspaces(scope).resolve(workspaceId, cwd);
  }
  async nativeAttachWorkspace(scope: ControlScope, workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaces(scope).attach(workspaceId, sessionId);
  }
  constructor(ctx: DurableObjectState, env: TenantEnvironment) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agents (id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,revision))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
    );
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS native_child_owners (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL)');
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_plugins (id TEXT PRIMARY KEY, revision TEXT NOT NULL, enabled INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_revisions (revision TEXT PRIMARY KEY, document TEXT NOT NULL, module TEXT NOT NULL)",
    );
  }
  protected abstract scope(scope: ControlScope): void;
  nativeSessionRoot(scope: ControlScope, sessionId: string): string | undefined {
    this.scope(scope); id.parse(sessionId);
    if (this.ctx.storage.sql.exec('SELECT id FROM sessions WHERE id=?', sessionId).toArray().length) return sessionId;
    return this.ctx.storage.sql.exec<{root_id: string}>('SELECT root_id FROM native_child_owners WHERE id=?', sessionId).toArray()[0]?.root_id;
  }
  nativeRegisterChild(scope: ControlScope, rootId: string, parentId: string, childId: string): void {
    this.scope(scope); id.parse(rootId); id.parse(parentId); id.parse(childId);
    if (childId === rootId || this.nativeSessionRoot(scope, parentId) !== rootId) throw new Error('Invalid native child owner');
    this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT id FROM sessions WHERE id=?', childId).toArray().length) throw new Error('Child id belongs to a root session');
      const known = this.ctx.storage.sql.exec<{parent_id: string; root_id: string}>('SELECT parent_id,root_id FROM native_child_owners WHERE id=?', childId).toArray()[0];
      if (known && (known.parent_id !== parentId || known.root_id !== rootId)) throw new Error('Native child owner cannot change');
      this.ctx.storage.sql.exec('INSERT INTO native_child_owners VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', childId, parentId, rootId);
    });
  }
  nativeDefaultModel(scope: ControlScope) {
    this.scope(scope);
    this.ensureDefault();
    return this.latest('default')?.spec.model;
  }
  nativeEvent(scope: ControlScope, event: string, args: readonly unknown[]): void {
    this.scope(scope);
    this.nativeEvents.emit(event, args);
    if (event === 'api-session/added') {
      const {items} = sessionRemote.methods['session/list'].result.create().parse({items: [args[0]]});
      const row = items[0]!;
      if (row.projections?.kind === 'sequenced' && row.projections.asOfSeq >= 0) {
        for (const [key,value] of Object.entries(row.projections.values)) {
          const frame = sessionRemote.methods['session/control'].result.create().parse({type: 'projection', sessionId: row.sessionId, key, value, seq: row.projections.asOfSeq});
          this.nativeControl.emit(frame);
        }
      }
    }
  }
  override async fetch(request: Request): Promise<Response> {
    const raw: unknown = await request.json();
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-session-search') {
      const body = z.object({operation: z.literal('native-session-search'), scope: environmentScopeSchema, query: z.string()}).strict().parse(raw);
      this.scope(body.scope);
      try {
        const value = await this.sessionSearch(body.scope).search(body.query, request.signal);
        return Response.json({ok: true, value: sessionRemote.methods['session/search'].result.create().parse(value)});
      } catch (error) {
        const failure = remoteErrorOf(error) ?? {code: 'gateway/internal', message: 'Session search failed', details: {}};
        return Response.json({ok: false, error: {isDSHRemoteError: true, code: failure.code, message: failure.message, details: failure.details}});
      }
    }
    const body = z.object({operation: z.enum(['native-events','native-workspaces','native-session-control']), scope: environmentScopeSchema}).strict().parse(raw);
    this.scope(body.scope);
    const abort = new AbortController();
    if (request.signal.aborted) abort.abort();
    else request.signal.addEventListener('abort', () => abort.abort(), {once: true});
    if (body.operation === 'native-session-control') {
      const owner = body.scope;
      const source = this.nativeControl.open(abort.signal, async () => {
        const projections: Record<string, SessionProjectionBaseline> = {};
        const records = await this.sessionIndex(body.scope);
        await mapConcurrent(records, async row => {
          const scope = {...owner, sessionId: row.id};
          const raw: unknown = await (await this.env.SESSIONS.getByName(sessionAddress(scope)).nativeSessionSummaries(scope)).json();
          const value = sessionRemote.methods['session/list'].result.create().parse(raw);
          for (const item of value.items) if (item.projections?.kind === 'sequenced') projections[item.sessionId] = {asOfSeq: item.projections.asOfSeq, values: item.projections.values};
        }, abort.signal);
        return {type: 'baseline', value: {projections}};
      });
      const codec = sessionRemote.methods['session/control'].result.create();
      return remoteStream(source, abort, value => codec.parse(value));
    }
    return remoteStream(body.operation === 'native-events' ? this.nativeEvents.open(abort.signal) : this.workspaces(body.scope).follow(abort.signal), abort);
  }
  private latest(agentId: string): AgentRevision | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        document: string;
      }>(
        "SELECT document FROM agents WHERE id=? ORDER BY revision DESC LIMIT 1",
        agentId,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.document) as AgentRevision) : undefined;
  }
  private ensureDefault(): void {
    if (this.latest("default")) return;
    const value: AgentRevision = {
      revision: 1,
      publishedAt: new Date().toISOString(),
      upstream: upstream.commit,
      spec: {
        id: "default",
        name: "DeepSeek Assistant",
        persona:
          "You are a helpful assistant. Use the workspace and available plugins to complete the user’s request.",
        workspaceId: "default",
        allowClientPlugins: false,
        plugins: profileDefinitions.find(definition => definition.id === 'default')!.plugins.map(row => ({id: row.id!, config: structuredClone(row.config) as Record<string, unknown>})),
      },
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO agents VALUES (?,?,?)",
      "default",
      1,
      JSON.stringify(value),
    );
  }
  private ensureNativePresets(): void {
    const original = this.latest('default')!;
    for (const definition of profileDefinitions.filter(definition => definition.id !== 'default')) {
      const {id, name = id} = definition;
      if (this.latest(id)) continue;
      const value: AgentRevision = {...structuredClone(original), revision: 1, publishedAt: new Date().toISOString(), spec: {...structuredClone(original.spec), id, name, allowClientPlugins: id === 'cordis', plugins: definition.plugins.map(row => ({id: row.id!, config: structuredClone(row.config) as Record<string, unknown>}))}};
      this.ctx.storage.sql.exec('INSERT INTO agents VALUES (?,?,?)', id, 1, JSON.stringify(value));
    }
  }
  async state(tenantId: ControlScope): Promise<TenantState> {
    this.scope(tenantId);
    this.ensureDefault();
    const agents = this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT a.document FROM agents a WHERE revision=(SELECT MAX(revision) FROM agents b WHERE b.id=a.id) ORDER BY id",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as AgentRevision);
    const sessions = this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT document FROM sessions ORDER BY json_extract(document,'$.updatedAt') DESC,id",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as SessionRecord);
    const clientPlugins = this.ctx.storage.sql
      .exec<{ document: string; enabled: number }>(
        "SELECT r.document,p.enabled FROM client_plugins p JOIN client_revisions r ON r.revision=p.revision ORDER BY p.id",
      )
      .toArray()
      .map((row) => ({
        ...(JSON.parse(row.document) as ClientPlugin),
        enabled: !!row.enabled,
      }));
    return { agents, sessions, clientPlugins };
  }
  async publishAgent(
    tenantId: ControlScope,
    input: unknown,
    expectedRevision: number,
  ): Promise<Response> {
    this.scope(tenantId);
    this.ensureDefault();
    const parsed = agentSchema.safeParse(input);
    if (!parsed.success)
      return Response.json(
        { error: "Invalid agent definition" },
        { status: 400 },
      );
    try {
      validatePlugins(parsed.data.plugins, parsed.data.workspaceId);
    } catch {
      return Response.json(
        { error: "Invalid native plugin configuration" },
        { status: 400 },
      );
    }
    if (parsed.data.disabled && parsed.data.id === this.presetDefault(tenantId)) return Response.json({error: 'Select another new-task default before disabling this preset'}, {status: 409});
    const current = this.latest(parsed.data.id)?.revision ?? 0;
    if (expectedRevision !== current)
      return Response.json(
        { error: "Agent changed; reload before publishing" },
        { status: 409 },
      );
    if (
      !current &&
      this.ctx.storage.sql
        .exec<{
          count: number;
        }>("SELECT COUNT(DISTINCT id) AS count FROM agents")
        .one().count >= 64
    )
      return Response.json({ error: "Agent limit reached" }, { status: 409 });
    const value: AgentRevision = {
      spec: parsed.data,
      revision: current + 1,
      publishedAt: new Date().toISOString(),
      upstream: upstream.commit,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO agents VALUES (?,?,?)",
      value.spec.id,
      value.revision,
      JSON.stringify(value),
    );
    await this.settings(tenantId).invalidate(PRESET_NAMESPACE);
    return Response.json(value);
  }
  async agent(
    tenantId: ControlScope,
    agentId: string,
    revision?: number,
  ): Promise<AgentRevision | undefined> {
    this.scope(tenantId);
    this.ensureDefault();
    id.parse(agentId);
    if (revision === undefined) return this.latest(agentId);
    const row = this.ctx.storage.sql
      .exec<{
        document: string;
      }>(
        "SELECT document FROM agents WHERE id=? AND revision=?",
        agentId,
        revision,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.document) as AgentRevision) : undefined;
  }
  async trackSession(
    tenantId: ControlScope,
    record: SessionRecord,
  ): Promise<void> {
    this.scope(tenantId);
    id.parse(record.id);
    if (this.ctx.storage.sql.exec('SELECT id FROM native_child_owners WHERE id=?', record.id).toArray().length) throw new Error('Session id belongs to a native child');
    const previous = this.ctx.storage.sql
      .exec<{
        document: string;
      }>("SELECT document FROM sessions WHERE id=?", record.id)
      .toArray()[0];
    if (previous)
      record = {
        ...record,
        title: (JSON.parse(previous.document) as SessionRecord).title || record.title,
      };
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      record.id,
      JSON.stringify(record),
    );
    await this.ctx.storage.sync();
  }
  async sessionIndex(scope: ControlScope): Promise<SessionRecord[]> {
    this.scope(scope);
    return this.ctx.storage.sql.exec<{document: string}>("SELECT document FROM sessions ORDER BY json_extract(document,'$.updatedAt') DESC,id").toArray().map(row => JSON.parse(row.document) as SessionRecord);
  }
  async publishClient(
    tenantId: ControlScope,
    input: unknown,
  ): Promise<Response> {
    this.scope(tenantId);
    const parsed = clientPluginSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid client plugin" }, { status: 400 });
    const exists = this.ctx.storage.sql
      .exec("SELECT id FROM client_plugins WHERE id=?", parsed.data.id)
      .toArray().length;
    if (
      !exists &&
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM client_plugins")
        .one().count >= 64
    )
      return Response.json(
        { error: "Client plugin limit reached" },
        { status: 409 },
      );
    let module: string;
    try {
      module = compileClientPlugin(parsed.data.source);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Client compilation failed",
        },
        { status: 400 },
      );
    }
    // Never interpolate source in HTML. It is served as an authenticated ESM response.
    const revision = crypto.randomUUID();
    const value = {
      ...parsed.data,
      revision,
      publishedAt: new Date().toISOString(),
    };
    const size = this.ctx.storage.sql
      .exec<{
        size: number;
      }>(
        "SELECT COALESCE(SUM(length(module)+length(document)),0) AS size FROM client_revisions",
      )
      .one().size;
    if (size + module.length + JSON.stringify(value).length > 10_000_000)
      return Response.json(
        { error: "Client plugin revision storage limit reached" },
        { status: 409 },
      );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO client_revisions VALUES (?,?,?)",
        revision,
        JSON.stringify(value),
        module,
      );
      // New publications are staged. A human enables the exact immutable revision in the UI.
      this.ctx.storage.sql.exec(
        "INSERT INTO client_plugins VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=0",
        value.id,
        revision,
      );
    });
    await this.ctx.storage.sync();
    return Response.json({ ...value, enabled: false });
  }
  async enableClient(
    tenantId: ControlScope,
    pluginId: string,
    revision: string,
    enabled: boolean,
  ): Promise<Response> {
    this.scope(tenantId);
    id.parse(pluginId);
    const row = this.ctx.storage.sql
      .exec<{
        revision: string;
      }>("SELECT revision FROM client_plugins WHERE id=?", pluginId)
      .toArray()[0];
    if (!row)
      return Response.json(
        { error: "Client plugin not found" },
        { status: 404 },
      );
    if (row.revision !== revision)
      return Response.json(
        { error: "Plugin changed; review the current revision" },
        { status: 409 },
      );
    this.ctx.storage.sql.exec(
      "UPDATE client_plugins SET enabled=? WHERE id=?",
      enabled ? 1 : 0,
      pluginId,
    );
    await this.ctx.storage.sync();
    return Response.json({ enabled });
  }
  async clientModule(
    tenantId: ControlScope,
    revision: string,
  ): Promise<Response> {
    this.scope(tenantId);
    const row = this.ctx.storage.sql
      .exec<{
        module: string;
      }>(
        "SELECT r.module FROM client_revisions r JOIN client_plugins p ON r.revision=p.revision WHERE r.revision=? AND p.enabled=1",
        revision,
      )
      .toArray()[0];
    if (!row)
      return Response.json(
        { error: "Enabled client plugin not found" },
        { status: 404 },
      );
    return new Response(row.module, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}

export const environmentAddress = (scope: EnvironmentScope): string => {
  const value = environmentScopeSchema.parse(scope);
  return JSON.stringify([DATA_LAYOUT_VERSION, "environment", value.tenantId, value.environmentId]);
};

/** All environments, including default, use the same native state owner. */
export function controlScope(
  tenantId: string,
  environmentId?: string,
): ControlScope {
  return {tenantId, environmentId: environmentId ?? 'default'};
}
export function controlFor(env: TenantEnvironment, scope: ControlScope) {
  return env.ENVIRONMENTS.getByName(environmentAddress(scope));
}

/** Tenant catalogue only; every Harness runs in an EnvironmentDO. */
export class TenantDO extends DurableObject<TenantEnvironment> {
  private scope(scope: string): void {
    if (
      !this.ctx.id.equals(this.env.TENANTS.idFromName(tenantAddress(scope)))
    )
      throw new Error("Tenant object scope mismatch");
  }
  private environmentRows(): EnvironmentRecord[] {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
    );
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO environments VALUES (?,?)",
      "default",
      JSON.stringify({
        id: "default",
        name: "我的 Harness",
        createdAt: now,
        updatedAt: now,
      }),
    );
    return this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT document FROM environments ORDER BY id",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as EnvironmentRecord);
  }
  async environments(tenantId: string): Promise<EnvironmentRecord[]> {
    this.scope(tenantId);
    return this.environmentRows();
  }
  async environment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | undefined> {
    this.scope(tenantId);
    id.parse(environmentId);
    return this.environmentRows().find((row) => row.id === environmentId);
  }
  async createEnvironment(tenantId: string, input: unknown): Promise<Response> {
    this.scope(tenantId);
    const parsed = environmentCreateSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid environment" }, { status: 400 });
    const rows = this.environmentRows();
    const environmentId = parsed.data.id ?? crypto.randomUUID();
    if (rows.some((row) => row.id === environmentId))
      return Response.json(
        { error: "Environment already exists" },
        { status: 409 },
      );
    if (rows.length >= 64)
      return Response.json(
        { error: "Environment limit reached" },
        { status: 409 },
      );
    const now = new Date().toISOString();
    const record: EnvironmentRecord = {
      id: environmentId,
      name: parsed.data.name,
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO environments VALUES (?,?)",
      record.id,
      JSON.stringify(record),
    );
    await this.ctx.storage.sync();
    return Response.json(record, { status: 201 });
  }
}

/** Each named Harness environment has a separate SQLite object and Cordis state. */
export class EnvironmentDO extends HarnessStateDO {
  protected override scope(scope: ControlScope): void {
    if (
      !this.ctx.id.equals(
        this.env.ENVIRONMENTS.idFromName(environmentAddress(scope)),
      )
    )
      throw new Error("Environment object scope mismatch");
  }
}
