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
  type AgentSpec,
  type ClientPlugin,
  type SessionRecord,
  type TenantState,
} from "./contracts.ts";
import { validatePlugins } from "../../plugin-runtime/src/catalog.ts";
import { compileClientPlugin } from "../../client-plugins/src/compiler.ts";
import upstream from "../../../upstream.lock.json";
import { z } from 'zod';
import { NativeEventHub, NativeStreamHub, type NativeWaterfallOutcome } from './native-events.ts';
import { sessionReadPorts } from '../../native-query/src/ports.ts';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { openEnvironmentStream } from '../../native-environment/src/index.ts';
import { MarketWorld } from '../../native-environment/src/market.ts';
import { ConfigWriteQueue, DurableAgentRevisions, DurableSettingsDocuments } from '../../environment-storage/src/index.ts';
import { DurableSessionIndex } from './session-index.ts';
import {DurableSessionSummaries} from './session-summaries.ts';
import type { HarnessHomeFacts } from '../../native-environment/src/harness-home.ts';
import { EnvironmentModelWorld } from '../../native-models/src/environment.ts';
import { credentialRefFor, type EnvironmentModels } from '../../native-models/src/index.ts';
import { ScriptedAdapter } from '../../harness-runtime/src/scripted-adapter.ts';
import { EnvironmentDeepSeekFiles, EnvironmentUploadIndex } from '../../model-provider/src/files.ts';
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types';
import type { RemoteEventResult } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';

/** Official Agent-scoped waterfalls that the environment forwards to its clients. */
const remoteEventResultSchema = z.object({
  clientId: z.string().min(1), eventId: z.string().min(1),
  outcome: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('next')}).strict(),
    z.object({kind: z.literal('result'), value: z.json().optional()}).strict(),
    z.object({kind: z.literal('rejected'), error: z.object({name: z.string(), message: z.string(), code: z.string().optional(), details: z.json().optional()}).strict()}).strict(),
  ]),
}).strict();
export const NATIVE_FORWARDED_EVENTS = ['goal/activation-changed', 'commands/change', 'schedule/changed'] as const;
export const NATIVE_WATERFALLS = ['user-questions/request', 'approval/request'] as const;
/** The environment's configuration document in its default workspace, and the note left when an edit is rejected. */
export const SETTINGS_DOCUMENT_DIRECTORY = '/workspace/.dsh';
export const SETTINGS_DOCUMENT_PATH = '/workspace/.dsh/profile.yml';
const SETTINGS_DOCUMENT_ERROR_PATH = '/workspace/.dsh/profile.error.txt';
/** Asks the environment's clients to open the configuration document. */
export const SETTINGS_DOCUMENT_EVENT = 'weft/settings-document';

/** What a Session world reads from its environment when it opens and before each turn. */
export interface NativeSessionContext {
  revision: number;
  models: ReturnType<NativeSettings['modelSections']>;
  /** Whether each credential reference the model settings name has a value. */
  credentials: Record<string, boolean>;
  harnessHome: HarnessHomeFacts;
  loop: {maxParallelToolCalls: number};
  subagents: Record<string, unknown>;
  permissionDefault?: string;
  profileOverrides: Record<string, Record<string, unknown>>;
  profileEnablement: import('../../harness-profile/src/management.ts').ProfileEnablement;
  /** Where the environment's workspace commands run. */
  workspaceRuntime: {shell: WorkspaceShell; containerInstance: ContainerInstance};
  pluginPlan: import('../../plugin-registry/src/types.ts').PluginPlan;
}
import { NativeWorkspaces } from './native-workspaces.ts';
import type { WorkspaceDO } from '../../workspace/src/object.ts';
import type { SessionDO } from '../../../apps/worker/src/index.ts';
import { workspaceAddress, type WorkspaceOperation } from '../../workspace/src/protocol.ts';
import type { ContainerInstance } from '../../workspace/src/object.ts';
import type { WorkspaceShell } from '../../workspace/src/runtime-choice.ts';
import { sessionAddress, type SessionScope } from '../../tenant/src/index.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import type { SessionControlFrame, SessionProjectionBaseline } from '@deepseek-ai/dsh-api-session-controller/types';
import { remoteStream } from '../../harness-runtime/src/remote-stream.ts';
import { NativeSettings, PRESET_NAMESPACE, LOOP_NAMESPACE, SUBAGENT_NAMESPACE, PERMISSION_NAMESPACE, MARKET_NAMESPACE, MODEL_NAMESPACE, PI_AI_NAMESPACE, WORKSPACE_RUNTIME_NAMESPACE, DEFAULT_MODEL_NAMESPACE, PROFILE_PLUGINS_NAMESPACE } from './native-settings.ts';
import {readNativePresets, type CompositionEndpoint} from '../../native-composition/src/profile-host.ts';
import {profileDefinitions} from '../../harness-profile/src/index.ts';
import {manageNativePlugins} from '../../native-composition/src/manager.ts';
import {OfficialBundleRegistry} from '../../native-bundles/src/registry.ts';
import {availableBundleStates, composeBundleProfile, optionalBundleInfo, optionalBundlePlugins, TEAM_CLIENT, TEAM_BUNDLE} from '../../native-bundles/src/catalog.ts';
import {environmentPlugins} from '../../native-composition/src/extensions.ts';
import {Context} from '@deepseek-ai/cordis';
import {NativePluginPlatform} from '../../native-plugins/src/platform.ts';
import {permissionSchema} from '../../package-install/src/contracts.ts';
import {PackageInstaller} from '../../package-install/src/host.ts';
import {mountWorkspace} from '../../workspace/src/provider.ts';
import { ModelConfigurationError, type ModelEnvironment } from '../../model-provider/src/index.ts';
import {SqliteModelUploadIndex, type ModelUploadOperation} from '../../model-provider/src/files-protocol.ts';
import { DATA_LAYOUT_VERSION } from '../../tenant/src/layout.ts';
import { NativePluginCatalog } from './native-plugins.ts';
import {NativeSessionSearch} from '../../native-query/src/host.ts';
import {mapConcurrent} from '../../native-query/src/concurrent.ts';
import {RemoteError, remoteErrorOf} from '@deepseek-ai/dsh-typert-protocol';

declare const WEFT_VALIDATION_BUILD: boolean;

export interface HarnessEnvironment extends ModelEnvironment {
  PLUGIN_ARTIFACTS?: R2Bucket;
  PLUGIN_BUILDER?: Fetcher;
  TENANTS: DurableObjectNamespace<TenantDO>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: DurableObjectNamespace<SessionDO>;
  // Environment internals receive no D1 binding in their type contract.
}

/** The platform catalogue owns the D1 binding. */
export interface TenantEnvironment extends HarnessEnvironment {
  CONFIG_DB: D1Database;
}
/** The preset new tasks use until the user selects another: the official default. */
export const DEFAULT_PRESET = 'standard';
export const tenantAddress = (tenantId: string): string =>
  JSON.stringify([DATA_LAYOUT_VERSION, "tenant", id.parse(tenantId)]);

/** Environment-local Harness configuration, revisions and discoverable sessions. */
abstract class HarnessStateDO extends DurableObject<HarnessEnvironment> {
  private nativeSearch: NativeSessionSearch | undefined;
  private sessionSearch(scope: ControlScope): NativeSessionSearch {
    this.scope(scope);
    if (this.nativeSearch) return this.nativeSearch;
    const target = (sessionId: string) => {
      const address: SessionScope = {...scope, sessionId: id.parse(this.nativeSessionRoot(scope, sessionId) ?? sessionId)};
      return {scope: address, stub: this.env.SESSIONS.getByName(sessionAddress(address))};
    };
    return this.nativeSearch = new NativeSessionSearch(this.ctx.storage, sessionReadPorts(async signal => {
      signal?.throwIfAborted();
      return this.nativeSessionIds(scope);
    }, target));
  }
  /** Every root Session in the index plus the children their roots host. */
  async nativeSessionIds(scope: ControlScope): Promise<string[]> {return (await this.nativeSessionOwners(scope)).map(owner => owner.id);}
  /** The same Sessions with the root whose SessionDO owns each one. */
  async nativeSessionOwners(scope: ControlScope): Promise<{id: string; root: string}[]> {
    return [...(await this.sessionIndex(scope)).map(record => ({id: record.id, root: record.id})),
      ...this.ctx.storage.sql.exec<{id: string; root_id: string}>('SELECT id, root_id FROM native_child_owners ORDER BY id').toArray().map(row => ({id: row.id, root: row.root_id}))];
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
  /** Forwarded Agent-scoped waterfalls (`user-questions/request`, `approval/request`) wait for an environment client. */
  async nativeEventWaterfall(scope: ControlScope, eventId: string, event: string, agentId: string, request: Record<string, unknown>): Promise<NativeWaterfallOutcome> {
    this.scope(scope);
    z.uuid().parse(eventId);
    id.parse(agentId);
    if (!(NATIVE_WATERFALLS as readonly string[]).includes(event)) throw new Error('Unknown native waterfall');
    return this.nativeEvents.waterfall(eventId, event, agentId, request);
  }
  /** Root Agent notifications the official client subscribes to through Remote Events. */
  async nativeForwardEvent(scope: ControlScope, event: string, args: readonly unknown[]): Promise<void> {
    this.scope(scope);
    if (!(NATIVE_FORWARDED_EVENTS as readonly string[]).includes(event)) throw new Error('Unknown native event');
    this.nativeEvents.emit(event, args);
  }
  /** Resolve one credential reference for a Session's trusted native root; values never reach clients. */
  async nativeResolveCredential(scope: ControlScope, ref: string): Promise<{value: string; source: string} | undefined> {
    return this.settings(scope).credentials.resolve(credentialRef(ref));
  }
  async nativeEventWaterfallCancel(scope: ControlScope, eventId: string): Promise<void> {this.scope(scope); this.nativeEvents.cancel(z.uuid().parse(eventId));}
  async nativeEventResult(scope: ControlScope, raw: unknown): Promise<void> {this.scope(scope); this.nativeEvents.result(remoteEventResultSchema.parse(raw) as RemoteEventResult);}
  private nativeSettings: NativeSettings | undefined;
  private settings(scope: ControlScope): NativeSettings {
    this.scope(scope);
    this.ensureDefault();
    this.ensureNativePresets();
    if (!this.settingsDocuments) throw new Error('Environment settings are not loaded');
    const documents = this.settingsDocuments;
    return this.nativeSettings ??= new NativeSettings(this.ctx.storage, {
      // Thinking and output limits keep the original adapter defaults, as the official profile inlines none.
      providerBase: () => ({baseURL: 'https://api.deepseek.com/anthropic', streamIdleTimeoutMs: 60_000, retryPolicy: {mode: 'normal', maxRetries: 0}, apiKeyEnv: 'DEEPSEEK_API_KEY'}),
      modelBase: () => WEFT_VALIDATION_BUILD && this.env.MODEL_BACKEND === 'scripted'
        ? {provider: 'validation', model: 'scripted'}
        : {provider: 'deepseek-official', model: this.latest(DEFAULT_PRESET)?.spec.model?.name ?? 'deepseek-flash'},
      changed: (event, args) => {
        this.nativeEvents.emit(event, args);
        if (event === 'settings/document-updated' && ([PRESET_NAMESPACE, PROFILE_PLUGINS_NAMESPACE].includes(String(args[0])) || environmentPlugins.hasNamespace(String(args[0])))) this.nativeEvents.emit('plugin-manager/changed', [{reason: 'plugin'}]);
        if (event === 'settings/document-updated' && (args[0] === MODEL_NAMESPACE || args[0] === PI_AI_NAMESPACE || args[0] === DEFAULT_MODEL_NAMESPACE)) void this.modelWorld?.refresh().catch(() => { /* A rejected draft keeps the previous entries serving; the next read retries. */ });
        if (event === 'settings/document-updated' && args[0] === MARKET_NAMESPACE) {
          const previous = this.market;
          this.market = undefined;
          void previous?.dispose();
          this.nativeEvents.emit('plugin-market/changed', []);
        }
      },
      validatePreset: id => {const value = this.latest(id); if (!value || value.spec.disabled) throw new Error('Unknown preset');},
      openDocument: () => this.openSettingsDocument(scope),
    }, documents);
  }
  async nativeSettingsRequest(scope: ControlScope, endpoint: string, args: unknown): Promise<Response> {
    await this.syncSettingsDocument(scope);
    const response = await this.settings(scope).invoke(endpoint, args);
    // A form edit shows in an open document; the document took in its own edits above first.
    if (endpoint !== 'settings/describe' && endpoint !== 'settings/openSettingsDocument') await this.renderSettingsDocument(scope);
    return response;
  }
  /** The tenant registers a new environment only after its initial profile is valid and durable. */
  async nativeInitializeEnvironment(scope: ControlScope, configuration: string): Promise<Response> {
    this.scope(scope);
    if (typeof configuration !== 'string' || configuration.length > 65_536) return Response.json({error: 'Invalid environment configuration'}, {status: 400});
    const settings = this.settings(scope);
    try {settings.validateDocument(configuration);}
    catch (error) {return Response.json({error: `环境 YAML 配置无效：${error instanceof Error ? error.message : String(error)}`}, {status: 400});}
    await settings.replaceDocument(configuration);
    await this.writeSettingsDocument(scope);
    await this.ctx.storage.sync();
    return Response.json({initialized: true});
  }
  /**
   * The configuration document lives in the environment's default workspace,
   * where the official file preview opens it and Agents edit it with their file
   * tools. Once opened, the object follows it: an edited file replaces the
   * configuration when every row passes, and a form edit rewrites the file.
   */
  private documentWork: Promise<unknown> = Promise.resolve();
  private documentSync: Promise<void> | undefined;
  private documentVolume(scope: ControlScope) { return {...scope, workspaceId: 'default'}; }
  private async documentCall<T>(scope: ControlScope, operation: WorkspaceOperation): Promise<T | undefined> {
    const volume = this.documentVolume(scope);
    const response = await this.env.WORKSPACES.getByName(workspaceAddress(volume)).call(volume, operation);
    if (response.status === 404) return undefined;
    const body = await response.json() as {value?: T; error?: string};
    if (!response.ok) throw new Error(body.error ?? `Workspace operation failed (${response.status})`);
    return body.value;
  }
  private documentVersion(): string | undefined {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS settings_document (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL)');
    return this.ctx.storage.sql.exec<{version: string}>('SELECT version FROM settings_document WHERE id = 1').toArray()[0]?.version;
  }
  private rememberDocument(version: string): void {
    this.documentVersion();
    this.ctx.storage.sql.exec('INSERT INTO settings_document VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version', version);
  }
  private serialDocument<T>(work: () => Promise<T>): Promise<T> {
    const run = this.documentWork.then(work, work);
    this.documentWork = run.catch(() => {});
    return run;
  }
  private writeSettingsDocument(scope: ControlScope): Promise<void> {
    return this.serialDocument(async () => {
      if (!await this.documentCall(scope, {type: 'stat', path: SETTINGS_DOCUMENT_DIRECTORY})) await this.documentCall(scope, {type: 'mkdir', path: SETTINGS_DOCUMENT_DIRECTORY});
      const written = await this.documentCall<{version: string}>(scope, {type: 'write', path: SETTINGS_DOCUMENT_PATH, content: this.settings(scope).document()});
      if (written) this.rememberDocument(written.version);
    });
  }
  private async renderSettingsDocument(scope: ControlScope): Promise<void> {
    if (this.documentVersion() !== undefined) await this.writeSettingsDocument(scope);
  }
  private async openSettingsDocument(scope: ControlScope): Promise<void> {
    await this.writeSettingsDocument(scope);
    this.nativeEvents.emit(SETTINGS_DOCUMENT_EVENT, [{path: SETTINGS_DOCUMENT_PATH}]);
  }
  /** Take in the document's edits, once per file version. */
  private syncSettingsDocument(scope: ControlScope): Promise<void> {
    if (this.documentVersion() === undefined) return Promise.resolve();
    if (this.documentSync) return this.documentSync;
    const pending = this.serialDocument(async () => {
      const known = this.documentVersion();
      const info = await this.documentCall<{version: string}>(scope, {type: 'stat', path: SETTINGS_DOCUMENT_PATH});
      if (!info || info.version === known) return;
      const file = await this.documentCall<{version: string; content: string}>(scope, {type: 'read', path: SETTINGS_DOCUMENT_PATH});
      if (!file) return;
      try {
        await this.settings(scope).replaceDocument(file.content, () => this.rememberDocument(file.version));
      } catch (error) {
        await this.documentCall(scope, {type: 'write', path: SETTINGS_DOCUMENT_ERROR_PATH, content: `${new Date().toISOString()}: the configuration in profile.yml was not applied and the previous configuration stays in effect.\n${error instanceof Error ? error.message : String(error)}\n`});
        return;
      }
      await this.documentCall(scope, {type: 'write', path: SETTINGS_DOCUMENT_ERROR_PATH, content: ''});
    });
    this.documentSync = pending;
    void pending.finally(() => {if (this.documentSync === pending) this.documentSync = undefined;}).catch(() => {});
    return pending;
  }
  private presetDefault(scope: ControlScope): string {
    const value = this.settings(scope).value(PRESET_NAMESPACE);
    return String(value.selectedDefault ?? value.default);
  }
  async nativePresetDefault(scope: ControlScope): Promise<string> {return this.presetDefault(scope);}
  /**
   * Everything a Session world reads from its environment, in one round trip:
   * a world opens and starts each turn with this instead of a call per setting.
   * Credentials are reported as set or unset, never their values.
   */
  async nativeSessionContext(scope: ControlScope, knownRevision?: number): Promise<Response> {
    this.scope(scope);
    await this.syncSettingsDocument(scope);
    const settings = this.settings(scope);
    if (knownRevision === settings.revision) return Response.json({unchanged: true, revision: knownRevision});
    const models = settings.modelSections();
    const providers = models.piAi.providers !== null && typeof models.piAi.providers === 'object' ? Object.keys(models.piAi.providers) : [];
    const refs = new Set(['deepseek-official', ...providers].flatMap(provider => credentialRefFor(models as EnvironmentModels, provider) ?? []));
    const credentials: Record<string, boolean> = {};
    for (const ref of refs) {
      try { credentials[ref] = await settings.credentials.resolve(credentialRef(ref)) !== undefined; }
      catch { credentials[ref] = false; }
    }
    const permission = settings.value(PERMISSION_NAMESPACE).defaultPreset;
    const context: NativeSessionContext = {
      revision: settings.revision,
      models, credentials, harnessHome: await this.nativeHarnessHome(scope),
      loop: settings.value(LOOP_NAMESPACE) as {maxParallelToolCalls: number}, subagents: settings.value(SUBAGENT_NAMESPACE),
      ...(typeof permission === 'string' ? {permissionDefault: permission} : {}),
      profileOverrides: settings.profileOverrides(),
      profileEnablement: settings.profileEnablement(),
      workspaceRuntime: settings.value(WORKSPACE_RUNTIME_NAMESPACE) as NativeSessionContext['workspaceRuntime'],
      pluginPlan: settings.pluginPlan(),
    };
    return Response.json(context);
  }
  /** Private RPC: the environment's declarative plugin composition. */
  async nativePluginPlan(scope: ControlScope) {
    this.scope(scope);
    await this.syncSettingsDocument(scope);
    return Response.json(this.settings(scope).pluginPlan());
  }
  /** The environment's configuration of official profile rows, by row id. */
  async nativeProfileOverrides(scope: ControlScope): Promise<Record<string, Record<string, unknown>>> {
    await this.syncSettingsDocument(scope);
    return this.settings(scope).profileOverrides();
  }
  async nativeLoopConfiguration(scope: ControlScope): Promise<Response> {
    return Response.json(this.settings(scope).value(LOOP_NAMESPACE));
  }
  /** The environment's default permission preset for new Sessions, when the user chose one. */
  async nativePermissionDefault(scope: ControlScope): Promise<string | undefined> {
    const value = this.settings(scope).value(PERMISSION_NAMESPACE).defaultPreset;
    return typeof value === 'string' ? value : undefined;
  }
  async nativeSubagentConfiguration(scope: ControlScope): Promise<Response> {
    return Response.json(this.settings(scope).value(SUBAGENT_NAMESPACE));
  }
  /** A preset's revision; without a preset, the environment's default preset. */
  async nativeProfile(scope: ControlScope, preset: string | undefined, revision?: number): Promise<Response> {
    this.scope(scope); this.ensureDefault(); this.ensureNativePresets();
    const value = await this.agent(scope, preset ?? this.presetDefault(scope), revision);
    return Response.json({value: value?.spec.disabled ? undefined : value ? composeBundleProfile(value, this.officialBundles().list()) : undefined});
  }
  async nativePresetIds(scope: ControlScope): Promise<string[]> {return (await this.state(scope)).agents.filter(row => !row.spec.disabled).map(row => row.spec.id);}
  /**
   * Preset inspections composed for the current preset revisions and default.
   * Composing an inspection world is the heaviest read the browser makes at
   * boot, and its result changes only when a preset or the default does.
   */
  private presetReads = new Map<string, Promise<string>>();
  private presetReadsVersion = '';
  private officialBundleRegistry: OfficialBundleRegistry | undefined;
  private officialBundles(): OfficialBundleRegistry {return this.officialBundleRegistry ??= new OfficialBundleRegistry(this.ctx.storage);}
  async nativeOfficialBundleClients(scope: ControlScope): Promise<string[]> {
    this.scope(scope);
    return availableBundleStates(this.officialBundles().list()).some(row => row.name === TEAM_BUNDLE && row.enabled) ? [TEAM_CLIENT] : [];
  }
  private packageInstaller: PackageInstaller | undefined;
  private packages(scope: ControlScope): PackageInstaller {
    this.scope(scope);
    return this.packageInstaller ??= new PackageInstaller({state: this.ctx, scope, bucket: this.env.PLUGIN_ARTIFACTS,
      build: async input => {
        if (this.env.PLUGIN_BUILDER) return this.env.PLUGIN_BUILDER.fetch('http://builder/build', {method: 'POST', body: input});
        const exported = this.ctx.exports as unknown as {PluginBuilderDO?: DurableObjectNamespace<import('../../package-install/src/builder.ts').PluginBuilderDO>};
        if (!exported.PluginBuilderDO) throw new Error('Plugin builder is unavailable');
        return exported.PluginBuilderDO.getByName(this.ctx.id.toString()).build(input);
      },
      validate: async artifact => {
        if (!artifact.host) return;
        const context = new Context(), platform = new NativePluginPlatform(this.ctx, (this.env as TenantEnvironment & {LOADER?: WorkerLoader}).LOADER, scope);
        const runId = 'bundle-inspect-'+crypto.randomUUID();
        try {await platform.evaluate(context, 'inspect:'+artifact.name, runId, '', () => () => {}, {module: artifact.host, services: ['fs','tools','timer']});}
        finally {await platform.release(runId); await context.fiber.dispose();}
      },
      changed: async () => {this.presetReads.clear(); await this.nativeEvent(scope, 'plugin-manager/changed', [{reason: 'install'}]);},
      revoke: async name => {
        const sessions = await this.sessionIndex(scope);
        for (let offset = 0; offset < sessions.length; offset += 8) {
          const settled = await Promise.allSettled(sessions.slice(offset, offset + 8).map(row => {
            const address = {...scope, sessionId: row.id};
            return this.env.SESSIONS.getByName(sessionAddress(address)).nativeStopPackage(address, name);
          }));
          const failure = settled.find(row => row.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        }
      },
    });
  }
  async nativePackageList(scope: ControlScope): Promise<Response> {return Response.json(this.packages(scope).list(), {headers: {'cache-control': 'private, no-store'}});}
  async nativePackageArtifact(scope: ControlScope, name: string, digest: string, client = false): Promise<Response> {
    const packages = this.packages(scope);
    if (client && !packages.registry.get(name)?.permissions.client) throw new Error('Client module permission is not granted');
    return Response.json(await packages.artifact(name, digest));
  }
  async nativePackageOperation(scope: ControlScope, raw: unknown): Promise<Response> {
    const request = z.discriminatedUnion('operation', [
      z.object({operation: z.literal('list')}).strict(),
      z.object({operation: z.literal('install'), spec: z.string().max(250), requestId: z.string().max(100)}).strict(),
      z.object({operation: z.literal('approve'), name: z.string().max(214), digest: z.string().regex(/^[a-f0-9]{64}$/), permissions: permissionSchema.optional()}).strict(),
      z.object({operation: z.literal('review'), name: z.string().max(214), digest: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    ]).parse(raw);
    const packages = this.packages(scope);
    if (request.operation === 'install') return Response.json(await packages.start(request.spec, request.requestId), {status: 202});
    if (request.operation === 'approve') {await packages.approve(request.name, request.digest, request.permissions); return Response.json({ok: true});}
    if (request.operation === 'review') return Response.json(await packages.artifact(request.name, request.digest, false));
    return Response.json(packages.list());
  }
  override async alarm(): Promise<void> {await this.packages(environmentScopeOf(this.ctx.id.name)).recover();}
  async nativePreset(scope: ControlScope, endpoint: CompositionEndpoint, args: unknown): Promise<Response> {
    await this.syncSettingsDocument(scope);
    const defaultId = await this.nativePresetDefault(scope);
    const bundleStates = this.officialBundles().list();
    // Keep management readable when a deployment retires an installed version,
    // so users can uninstall or reinstall it. Session admission stays strict.
    const profiles = (await this.state(scope)).agents.map(profile => composeBundleProfile(profile, availableBundleStates(bundleStates)));
    const enablement = this.settings(scope).profileEnablement();
    const readConfig = (id: string) => this.settings(scope).value(id);
    const pluginPlan = environmentPlugins.plan(readConfig);
    const packages = this.packages(scope).registry;
    const version = JSON.stringify([defaultId, profiles.map(profile => [profile.spec.id, profile.revision]), enablement, packages.list(), bundleStates, pluginPlan]);
    if (version !== this.presetReadsVersion) {this.presetReads = new Map(); this.presetReadsVersion = version;}
    const key = JSON.stringify([endpoint, args]);
    let read = this.presetReads.get(key);
    if (!read) {
      const volume = {...scope, workspaceId: 'default'};
      read = readNativePresets(profiles, defaultId, endpoint, args, ctx => mountWorkspace(ctx, {scope: volume, transport: this.env.WORKSPACES.getByName(workspaceAddress(volume)), cwd: '/workspace', fileTools: false}), enablement, this.ctx.storage).then(async response => {
        const result = await response.json() as {value: unknown};
        if (endpoint === 'pluginManager/listBundles') result.value = [...result.value as unknown[], ...packages.bundles(), ...optionalBundleInfo(bundleStates), ...environmentPlugins.bundles(readConfig)];
        if (endpoint === 'pluginManager/listPlugins') result.value = [...result.value as unknown[], ...packages.plugins(), ...optionalBundlePlugins(bundleStates), ...environmentPlugins.inventory(readConfig)];
        if (endpoint === 'pluginInventory/list') {const inventory = result.value as {entries: unknown[]}; inventory.entries.push(...packages.plugins(), ...optionalBundlePlugins(bundleStates), ...environmentPlugins.inventory(readConfig));}
        return JSON.stringify(result);
      });
      const reads = this.presetReads;
      reads.set(key, read);
      // A failed composition is not remembered; the next read composes again.
      read.catch(() => { if (reads.get(key) === read) reads.delete(key); });
    }
    return new Response(await read, {headers: {'content-type': 'application/json'}});
  }
  /** The original market reader over this environment's index settings and bundle listing. */
  private market: MarketWorld | undefined;
  async nativePluginMarket(scope: ControlScope, endpoint: string, raw: unknown): Promise<Response> {
    const settings = this.settings(scope);
    const indexes = settings.value(MARKET_NAMESPACE).indexes;
    this.market ??= new MarketWorld({
      indexes: Array.isArray(indexes) ? indexes.map(String) : [],
      bundles: async () => ((await (await this.nativePreset(scope, 'pluginManager/listBundles', {})).json()) as {value: BundleInfo[]}).value,
      save: urls => settings.saveMarketIndexes(urls),
    });
    return Response.json({value: await this.market.invoke(endpoint, raw, AbortSignal.timeout(60_000))});
  }
  async nativeManagePlugins(scope: ControlScope, endpoint: string, raw: unknown): Promise<Response> {
    this.scope(scope); this.ensureDefault(); this.ensureNativePresets();
    await this.syncSettingsDocument(scope);
    const packages = this.packages(scope);
    const method = (await import('../../../.generated/official-remotes/packages/boot/plugin-manager/typert.remote-client.js')).default.methods[endpoint as 'pluginManager/installBundle'];
    if (!method) throw new Error('Unknown package operation');
    let args: Record<string, unknown>;
    try {args = method.input({strict: true}).create().parse(raw) as Record<string, unknown>;}
    catch {throw new RemoteError('gateway/bad-request', 'Invalid plugin management arguments', {});}
    if (endpoint === 'pluginManager/inspect') {
      const inspection = environmentPlugins.inspect(String(args.spec));
      if (inspection) return Response.json({value: inspection});
    }
    // The registry owns native identities and controls. NativeSettings owns
    // serialization; never wrap these writes in its queue a second time.
    const registered = await environmentPlugins.manage(endpoint, args, (control, enabled) => this.settings(scope).setPluginEnabled(control, enabled));
    if (registered) {
      if (registered.changed) {this.presetReads.clear(); await this.renderSettingsDocument(scope);}
      return Response.json({value: registered});
    }
    if (endpoint === 'pluginManager/setPluginEnabled' && optionalBundlePlugins(this.officialBundles().list()).some(row => row.entryId === args.id)) {
      return Response.json({value: {changed: false, application: 'failed', stage: 'enable', target: args.id, error: {code: 'management-required'}}});
    }
    // Trusted shipped bundle operations are admitted before the external npm
    // path, so even a public package with a familiar name cannot replace code.
    if (endpoint === 'pluginManager/inspect') {
      const inspection = this.officialBundles().inspect(String(args.spec));
      if (inspection) {
        const registry = (args.options as {registry?: string | null} | undefined)?.registry;
        return Response.json({value: registry != null && registry.replace(/\/$/, '') !== 'https://registry.npmjs.org'
          ? {status: 'refused', problem: 'invalid-spec', reason: 'Official prebuilt bundles cannot be replaced from a custom registry.'} : inspection});
      }
    }
    if (['pluginManager/installBundle', 'pluginManager/setBundleEnabled', 'pluginManager/removeBundle'].includes(endpoint)) {
      const result = await this.configWrites.run(() => this.officialBundles().change(endpoint, args));
      if (result) {
        if (result.changed) {this.presetReads.clear(); await this.settings(scope).invalidate(PRESET_NAMESPACE); await this.nativeEvent(scope, 'plugin-manager/changed', [{reason: result.stage}]);}
        return Response.json({value: result});
      }
    }
    const name = typeof args.name === 'string' ? args.name : typeof args.id === 'string' && args.id.startsWith('installed:') ? args.id.slice('installed:'.length) : undefined;
    if (name && packages.registry.get(name) && ['pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled', 'pluginManager/removeBundle'].includes(endpoint)) {
      try {
        if (endpoint === 'pluginManager/removeBundle') {await packages.remove(name); return Response.json({value: {changed: true, application: 'applied', stage: 'remove', target: name}});}
        const enabled = z.boolean().parse(args.enabled);
        const changed = await packages.enabled(name, enabled);
        return Response.json({value: {changed, application: 'applied', stage: 'enable', target: args.id ?? name, enabled, warnings: ['Host activation applies before the next turn.']}});
      } catch (error) {return Response.json({value: {changed: false, application: 'failed', stage: 'enable', target: name, error: {code: 'operation-error', diagnostic: error instanceof Error ? error.message : String(error)}}});}
    }
    const options = (args.options ?? {}) as {requestId?: string; registry?: string | null; approvedBuilds?: string[]};
    const unsupportedRegistry = options.registry != null && options.registry.replace(/\/$/, '') !== 'https://registry.npmjs.org';
    if (endpoint === 'pluginManager/registries') return Response.json({value: {registry: 'https://registry.npmjs.org/', fallbackRegistries: [], resolved: 'https://registry.npmjs.org/'}});
    if (endpoint === 'pluginManager/inspect') return Response.json({value: unsupportedRegistry
      ? {status: 'refused', problem: 'invalid-spec', reason: 'Only the public npm registry is supported in v1; private registries are never retried publicly.'}
      : await packages.inspect(String(args.spec))});
    if (endpoint === 'pluginManager/installBundle') {
      try {
        if (unsupportedRegistry || options.approvedBuilds?.length) throw new Error('Custom registries and dependency build scripts are unsupported in v1');
        const job = await packages.start(String(args.spec), options.requestId ?? crypto.randomUUID());
        const result = await packages.wait(job.id);
        return Response.json({value: {changed: result?.phase === 'review', application: result?.phase === 'review' ? 'applied' : 'failed', stage: 'install', target: args.spec,
          ...(result?.phase === 'review' ? {warnings: ['Installed disabled. Review the patch, exact artifact and capabilities on this bundle’s detail page to activate.']} : {error: {code: 'operation-error', diagnostic: result?.error ?? 'Installation did not complete'}})}});
      } catch (error) {return Response.json({value: {changed: false, application: 'failed', stage: 'install', target: args.spec, error: {code: 'operation-error', diagnostic: error instanceof Error ? error.message : String(error)}}});}
    }
    const response = await manageNativePlugins({
      profiles: async () => (await this.state(scope)).agents,
      defaultPreset: () => this.nativePresetDefault(scope),
      publish: (spec, revision) => this.publishAgent(scope, spec, revision),
      setProfileEnabled: (id, enabled) => this.settings(scope).setProfilePluginEnabled(id, enabled),
    }, endpoint, raw);
    const result = await response.clone().json() as {value?: {changed?: boolean}};
    if (result.value?.changed) await this.renderSettingsDocument(scope);
    return response;
  }
  /** Private binding only: never dispatch this snapshot as a client Remote. */
  /** Private binding only: the effective model sections for the official model entries. */
  async nativeModelSections(scope: ControlScope): Promise<Response> {
    this.scope(scope);
    await this.syncSettingsDocument(scope);
    return Response.json(this.settings(scope).modelSections());
  }
  private modelWorld: EnvironmentModelWorld | undefined;
  /** The official model directory, listings, discovery and catalog for this environment. */
  async nativeModelRemote(scope: ControlScope, endpoint: string, raw: unknown): Promise<Response> {
    this.scope(scope);
    const settings = this.settings(scope);
    const harnessHome = await this.nativeHarnessHome(scope);
    this.modelWorld ??= new EnvironmentModelWorld({
      models: () => settings.modelSections(),
      resolveCredential: ref => this.nativeResolveCredential(scope, ref),
      harnessHome: () => ({...harnessHome, deepSeekFiles: new EnvironmentDeepSeekFiles(new EnvironmentUploadIndex(operation => this.nativeModelFiles(scope, operation)))}),
      ...(WEFT_VALIDATION_BUILD && this.env.MODEL_BACKEND === 'scripted' ? {validationAdapter: () => new ScriptedAdapter()} : {}),
    });
    return Response.json({value: await this.modelWorld.invoke(endpoint, raw, AbortSignal.timeout(60_000))});
  }
  async nativeSaveDefaultModel(scope: ControlScope, selected: {provider: string; model: string; reasoningEffort?: string}): Promise<void> {
    await this.settings(scope).saveDefault(selected);
  }
  private readonly nativeEvents = new NativeEventHub();
  private readonly nativeControl = new NativeStreamHub<SessionControlFrame>();
  private summaries: DurableSessionSummaries | undefined;
  private summaryStore(): DurableSessionSummaries {return this.summaries ??= new DurableSessionSummaries(this.ctx.storage.sql);}
  private storeSummaries(scope: ControlScope, root: string, text: string, emit: boolean) {
    this.scope(scope);
    if (!this.sessions().has(id.parse(root))) throw new Error('Summary root is not registered');
    const raw = JSON.parse(text) as {revision: number; items: unknown};
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('Invalid summary revision');
    const {items} = sessionRemote.methods['session/list'].result.create().parse({items: raw.items});
    for (const row of items) if (row.sessionId !== root && this.nativeSessionRoot(scope, row.sessionId) !== root) throw new Error('Summary ownership mismatch');
    const accepted = this.summaryStore().put(root, raw.revision, items);
    if (accepted && emit) for (const row of items) {
      this.nativeEvent(scope, 'api-session/added', [row]);
      this.nativeEvent(scope, 'api-session/status', [row.sessionId, row.running]);
    }
    return items;
  }
  async nativeSyncSessionSummaries(scope: ControlScope, root: string, text: string): Promise<void> {this.storeSummaries(scope, root, text, true);}
  /** Only missing or still-active roots require a source RPC. Cold completed lists read local SQLite. */
  async nativeSessionList(scope: ControlScope): Promise<Response> {
    return this.listNativeSessions(scope);
  }
  private async listNativeSessions(scope: ControlScope, signal?: AbortSignal): Promise<Response> {
    this.scope(scope);
    signal?.throwIfAborted();
    const cached = this.summaryStore().read();
    const groups = await mapConcurrent(this.sessions().list(), async record => {
      const value = cached.get(record.id);
      if (value && !value.active) return value.items;
      const source = {...scope, sessionId: record.id};
      const text = await (await this.env.SESSIONS.getByName(sessionAddress(source)).nativeReadSummaryGroup(source)).text();
      return this.storeSummaries(scope, record.id, text, false);
    }, signal);
    return Response.json({items: groups.flat()});
  }
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
    const target = (sessionId: string) => {const root = this.nativeSessionRoot(owner, sessionId) ?? sessionId; const scope = {...owner, sessionId: root}; return {scope, stub: this.env.SESSIONS.getByName(sessionAddress(scope))};};
    return this.nativeWorkspaces = new NativeWorkspaces(this.ctx.storage, {
      persistence: sessionReadPorts(async () => this.nativeSessionIds(owner), target),
      files: operation => this.env.WORKSPACES.getByName(workspaceAddress(volume)).call(volume, operation),
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
  async nativeWorkspaceOf(scope: ControlScope, sessionId: string): Promise<string | undefined> {return this.workspaces(scope).owning(id.parse(sessionId));}
  async nativeAttachWorkspace(scope: ControlScope, workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaces(scope).attach(workspaceId, sessionId);
  }
  private settingsDocuments: DurableSettingsDocuments | undefined;
  private readonly configWrites = new ConfigWriteQueue();
  private agentRevisions: DurableAgentRevisions<AgentRevision> | undefined;
  private sessionRecords: DurableSessionIndex<SessionRecord> | undefined;
  constructor(ctx: DurableObjectState, env: HarnessEnvironment) {
    super(ctx, env);
    // Every environment-owned record is local; activation never waits for D1.
    environmentScopeOf(ctx.id.name);
    void ctx.blockConcurrencyWhile(async () => {
      // Sessions belong to this environment alone: their index lives in the object's own storage.
      this.sessionRecords = new DurableSessionIndex<SessionRecord>(ctx.storage.sql);
      this.settingsDocuments = new DurableSettingsDocuments(ctx.storage, this.configWrites);
      this.agentRevisions = new DurableAgentRevisions<AgentRevision>(ctx.storage);
      await this.seedAgents();
    });
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS native_child_owners (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL)');
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_plugins (id TEXT PRIMARY KEY, revision TEXT NOT NULL, enabled INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_revisions (revision TEXT PRIMARY KEY, document TEXT NOT NULL, module TEXT NOT NULL)",
    );
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_harness_home (id INTEGER PRIMARY KEY CHECK (id = 1), anonymous_user_id TEXT NOT NULL)');
  }
  /** This environment's harness home facts, minting its random anonymous id on first use. */
  async nativeHarnessHome(scope: ControlScope): Promise<HarnessHomeFacts> {
    this.scope(scope);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO weft_harness_home VALUES (1, ?)', crypto.randomUUID());
    return {anonymousUserId: this.ctx.storage.sql.exec<{anonymous_user_id: string}>('SELECT anonymous_user_id FROM weft_harness_home WHERE id = 1').one().anonymous_user_id};
  }
  protected abstract scope(scope: ControlScope): void;
  nativeSessionRoot(scope: ControlScope, sessionId: string): string | undefined {
    this.scope(scope); id.parse(sessionId);
    if (this.sessions().has(sessionId)) return sessionId;
    return this.ctx.storage.sql.exec<{root_id: string}>('SELECT root_id FROM native_child_owners WHERE id=?', sessionId).toArray()[0]?.root_id;
  }
  nativeRegisterChild(scope: ControlScope, rootId: string, parentId: string, childId: string): void {
    this.scope(scope); id.parse(rootId); id.parse(parentId); id.parse(childId);
    if (childId === rootId || this.nativeSessionRoot(scope, parentId) !== rootId) throw new Error('Invalid native child owner');
    this.ctx.storage.transactionSync(() => {
      if (this.sessions().has(childId)) throw new Error('Child id belongs to a root session');
      const known = this.ctx.storage.sql.exec<{parent_id: string; root_id: string}>('SELECT parent_id,root_id FROM native_child_owners WHERE id=?', childId).toArray()[0];
      if (known && (known.parent_id !== parentId || known.root_id !== rootId)) throw new Error('Native child owner cannot change');
      this.ctx.storage.sql.exec('INSERT INTO native_child_owners VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', childId, parentId, rootId);
    });
    this.summaryStore().remove(rootId);
  }
  nativeDefaultModel(scope: ControlScope) {
    this.scope(scope);
    this.ensureDefault();
    return this.latest(DEFAULT_PRESET)?.spec.model;
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
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-session-list') {
      const body = z.object({operation: z.literal('native-session-list'), scope: environmentScopeSchema}).strict().parse(raw);
      return this.listNativeSessions(body.scope, request.signal);
    }
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
    if (typeof raw === 'object' && raw !== null && 'operation' in raw && raw.operation === 'native-environment-stream') {
      const body = z.object({operation: z.literal('native-environment-stream'), scope: environmentScopeSchema, endpoint: z.string(), args: z.unknown()}).strict().parse(raw);
      this.scope(body.scope);
      // Long-lived environment streams live here: a stateless entry request that only awaits
      // non-I/O promises is cancelled by the runtime as hung.
      const abort = new AbortController();
      if (request.signal.aborted) abort.abort();
      else request.signal.addEventListener('abort', () => abort.abort(), {once: true});
      return openEnvironmentStream(body.endpoint, body.args, abort);
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
        const value = sessionRemote.methods['session/list'].result.create().parse(await (await this.listNativeSessions(owner, abort.signal)).json());
        for (const item of value.items) if (item.projections?.kind === 'sequenced') projections[item.sessionId] = {asOfSeq: item.projections.asOfSeq, values: item.projections.values};
        return {type: 'baseline', value: {projections}};
      });
      const codec = sessionRemote.methods['session/control'].result.create();
      return remoteStream(source, abort, value => codec.parse(value));
    }
    return remoteStream(body.operation === 'native-events' ? this.nativeEvents.open(abort.signal) : this.workspaces(body.scope).follow(abort.signal), abort);
  }
  private latest(agentId: string): AgentRevision | undefined {
    return this.agents().latest(agentId);
  }
  private sessions(): DurableSessionIndex<SessionRecord> {
    if (!this.sessionRecords) throw new Error('Environment Session index is not loaded');
    return this.sessionRecords;
  }
  private agents(): DurableAgentRevisions<AgentRevision> {
    if (!this.agentRevisions) throw new Error('Environment Agents are not loaded');
    return this.agentRevisions;
  }
  /** Every bundled official preset is published once, when the environment first activates. */
  private ensureDefault(): void { this.agents(); }
  private ensureNativePresets(): void { this.agents(); }
  /**
   * Publish the official presets. A preset whose latest revision is still the
   * one Weft published follows the official definition and upstream; once the
   * environment publishes its own revision, Weft leaves the preset alone.
   * Revision 1 is always Weft's, so presets seeded before the record existed
   * count as unchanged.
   */
  private async seedAgents(): Promise<void> {
    const agents = this.agents();
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS official_preset_seeds (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
    for (const definition of profileDefinitions) {
      const spec: AgentSpec = {
        id: definition.id,
        // Official presets keep their id as name; the client shows its localized official name.
        name: definition.id,
        // The preset's own persona row supplies the system prompt persona.
        persona: '',
        workspaceId: "default",
        allowClientPlugins: definition.id === 'cordis',
        plugins: definition.plugins.map(row => ({id: row.id!, config: structuredClone(row.config ?? {}) as Record<string, unknown>, ...(row.disabled === true ? {disabled: true} : {})})),
      };
      const latest = agents.latest(definition.id);
      if (latest) {
        const seeded = this.ctx.storage.sql.exec<{revision: number}>('SELECT revision FROM official_preset_seeds WHERE id=?', definition.id).toArray()[0]?.revision ?? 1;
        if (latest.revision !== seeded) continue;
        // Enablement is the environment's choice and survives a definition update.
        const current = {...spec, ...(latest.spec.disabled === undefined ? {} : {disabled: latest.spec.disabled})};
        if (latest.upstream === upstream.commit && JSON.stringify(latest.spec) === JSON.stringify(current)) continue;
        Object.assign(spec, current);
      }
      const revision = (latest?.revision ?? 0) + 1;
      // The seed and its ownership marker must survive or roll back together.
      this.ctx.storage.transactionSync(() => {
        if (agents.publish(definition.id, {revision, publishedAt: new Date().toISOString(), upstream: upstream.commit, spec})) {
          this.ctx.storage.sql.exec('INSERT INTO official_preset_seeds VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision', definition.id, revision);
        }
      });
    }
  }

  async state(tenantId: ControlScope): Promise<TenantState> {
    this.scope(tenantId);
    this.ensureDefault();
    const agents = this.agents().current();
    const sessions = this.sessions().list();
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
    // The default-preset check and the publication it guards run on the queue settings writes share.
    const published = await this.configWrites.run(async (): Promise<Response | AgentRevision> => {
      if (parsed.data.disabled && parsed.data.id === this.presetDefault(tenantId)) return Response.json({error: 'Select another new-task default before disabling this preset'}, {status: 409});
      const current = this.latest(parsed.data.id)?.revision ?? 0;
      if (expectedRevision !== current)
        return Response.json(
          { error: "Agent changed; reload before publishing" },
          { status: 409 },
        );
      if (
        !current &&
        this.agents().count >= 64
      )
        return Response.json({ error: "Agent limit reached" }, { status: 409 });
      const value: AgentRevision = {
        spec: parsed.data,
        revision: current + 1,
        publishedAt: new Date().toISOString(),
        upstream: upstream.commit,
      };
      if (!await this.agents().publish(value.spec.id, value))
        return Response.json({ error: "Agent changed; reload before publishing" }, { status: 409 });
      return value;
    });
    if (published instanceof Response) return published;
    const value = published;
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
    return this.agents().revision(agentId, revision);
  }
  async trackSession(
    tenantId: ControlScope,
    record: SessionRecord,
  ): Promise<void> {
    this.scope(tenantId);
    id.parse(record.id);
    if (this.ctx.storage.sql.exec('SELECT id FROM native_child_owners WHERE id=?', record.id).toArray().length) throw new Error('Session id belongs to a native child');
    const previous = this.sessions().get(record.id);
    if (previous) record = {...record, title: previous.title || record.title};
    this.sessions().put(record);
    this.summaryStore().remove(record.id);
  }
  async sessionIndex(scope: ControlScope): Promise<SessionRecord[]> {
    this.scope(scope);
    return this.sessions().list();
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

/** The environment an EnvironmentDO serves, read from the name it was addressed by. */
export function environmentScopeOf(name: string | undefined): ControlScope {
  if (name === undefined) throw new Error('Environment objects are addressed by name');
  const [version, kind, tenantId, environmentId] = JSON.parse(name) as unknown[];
  if (version !== DATA_LAYOUT_VERSION || kind !== 'environment' || typeof tenantId !== 'string' || typeof environmentId !== 'string') throw new Error('Unexpected environment object name');
  return environmentScopeSchema.parse({tenantId, environmentId}) as ControlScope;
}

/** All environments, including default, use the same native state owner. */
export function controlScope(
  tenantId: string,
  environmentId?: string,
): ControlScope {
  return {tenantId, environmentId: environmentId ?? 'default'};
}
export function controlFor(env: HarnessEnvironment, scope: ControlScope) {
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
  private tail: Promise<unknown> = Promise.resolve();
  /** Registry writes run one at a time, so the limit check and insert see one state. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  /**
   * The tenant's environments, read from D1 once per activation: this object is
   * the registry's only writer, so its copy stays current. Every request names
   * an environment, so the registry must not cost a D1 round trip each time.
   */
  private registry: Promise<EnvironmentRecord[]> | undefined;
  private environmentRows(tenantId: string): Promise<EnvironmentRecord[]> {
    const load = async () => {
      const db = this.env.CONFIG_DB;
      const now = new Date().toISOString();
      const fallback: EnvironmentRecord = {id: "default", name: "我的 Harness", createdAt: now, updatedAt: now};
      await db.prepare('INSERT INTO environments (tenant_id, environment_id, document) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(tenantId, 'default', JSON.stringify(fallback)).run();
      const {results} = await db.prepare('SELECT document FROM environments WHERE tenant_id = ? ORDER BY environment_id').bind(tenantId).all<{document: string}>();
      return results.map(row => JSON.parse(row.document) as EnvironmentRecord);
    };
    const pending = this.registry ??= load();
    // A failed read is not remembered; the next request reads again.
    pending.catch(() => { if (this.registry === pending) this.registry = undefined; });
    return pending.then(rows => structuredClone(rows));
  }
  async environments(tenantId: string): Promise<EnvironmentRecord[]> {
    this.scope(tenantId);
    return this.environmentRows(tenantId);
  }
  async environment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | undefined> {
    this.scope(tenantId);
    id.parse(environmentId);
    return (await this.environmentRows(tenantId)).find((row) => row.id === environmentId);
  }
  async createEnvironment(tenantId: string, input: unknown): Promise<Response> {
    this.scope(tenantId);
    const parsed = environmentCreateSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid environment" }, { status: 400 });
    return this.serialized(async () => {
      const rows = await this.environmentRows(tenantId);
      const environmentId = parsed.data.id ?? crypto.randomUUID();
      if (rows.some((row) => row.id === environmentId))
        return Response.json({ error: "Environment already exists" }, { status: 409 });
      if (rows.length >= 64)
        return Response.json({ error: "Environment limit reached" }, { status: 409 });
      if (parsed.data.configuration !== undefined) {
        const scope = {tenantId, environmentId};
        const initialized = await this.env.ENVIRONMENTS.getByName(environmentAddress(scope)).nativeInitializeEnvironment(scope, parsed.data.configuration);
        if (!initialized.ok) return initialized;
      }
      const now = new Date().toISOString();
      const record: EnvironmentRecord = {id: environmentId, name: parsed.data.name, createdAt: now, updatedAt: now};
      const result = await this.env.CONFIG_DB.prepare('INSERT INTO environments (tenant_id, environment_id, document) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(tenantId, record.id, JSON.stringify(record)).run();
      if (result.meta.changes !== 1) {
        this.registry = undefined;
        return Response.json({ error: "Environment already exists" }, { status: 409 });
      }
      this.registry = Promise.resolve([...rows, record].sort((left, right) => left.id.localeCompare(right.id)));
      return Response.json(record, { status: 201 });
    });
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
