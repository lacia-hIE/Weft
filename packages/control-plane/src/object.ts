import { DurableObject } from "cloudflare:workers";
import {LocalHostRelay,LOCAL_PROTOCOL,supportsLocalProtocol,newKey,hashKey} from '../../local-host/src/relay.ts';
import {
  environmentCreateSchema,
  environmentCopySchema,
  environmentRenameSchema,
  environmentLifecycleSchema,
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
import {DurableCopySnapshots,type EnvironmentCopyConfiguration} from './environment-copy.ts';
import type {EnvironmentLifecycleJob} from './environment-lifecycle.ts';
import { compileClientPlugin } from "../../client-plugins/src/compiler.ts";
import upstream from "../../../upstream.lock.json";
import {supportsDshVersion,SUPPORTED_DSH_VERSIONS} from '../../local-host-connector/compatibility.mjs';
import { z } from 'zod';
import { NativeEventHub, NativeStreamHub, type NativeWaterfallOutcome } from './native-events.ts';
import { sessionReadPorts } from '../../native-query/src/ports.ts';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { openEnvironmentStream } from '../../native-environment/src/index.ts';
import { MarketWorld } from '../../native-environment/src/market.ts';
import { ConfigWriteQueue, DurableAgentRevisions, DurableSettingsDocuments } from '../../environment-storage/src/index.ts';
import {LifecycleGate,guardLifecycle} from '../../environment-storage/src/lifecycle.ts';
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
  /** Remote MCP servers, with their header values; only Sessions read them. */
  mcpServers: import('../../native-mcp/src/index.ts').McpServer[];
}
import {openPermissionWorld} from '../../native-environment/src/permissions.ts';
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
import {webhookDelivery,webhookSessionRequest} from '../../native-plugins/src/webhook-contracts.ts';
import {entryNamespace, entrySchemasSchema, isEntryNamespace, permissionSchema} from '../../package-install/src/contracts.ts';
import {bundleLeaves} from '../../package-install/src/composition.ts';
import {MCP_NAMESPACE} from '../../native-mcp/src/index.ts';
import {EnvironmentPackages, environmentFacetName} from '../../package-install/src/environment.ts';
import {workerHostServices, environmentHostServices} from '../../native-plugins/src/services.ts';
import type {Artifact, Installation} from '../../package-install/src/contracts.ts';
import {PackageInstaller} from '../../package-install/src/host.ts';
import {bundledPackageInfo} from '../../package-install/src/bundled.ts';
import {mountWorkspace, ComputerFileSystem} from '../../workspace/src/provider.ts';
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
  protected readonly lifecycle:LifecycleGate;
  nativeRegisterResource(scope:ControlScope,kind:'session'|'workspace',resourceId:string):void {
    this.lifecycle.maintenance(()=>{
    this.scope(scope);id.parse(resourceId);
    if(this.lifecycle.mode==='deleted')throw new Error('Environment was deleted');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_resources (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT');
    if(this.lifecycle.mode!=='active'){
      if(this.ctx.storage.sql.exec('SELECT id FROM weft_environment_resources WHERE kind=? AND id=?',kind,resourceId).toArray().length)return;
      throw new Error('Environment is stopped');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO weft_environment_resources VALUES (?,?)',kind,resourceId);
    });
  }
  async nativeLifecycle(scope:ControlScope,action:'freeze'|'resume'|'delete',operation:number):Promise<Response> {
    this.lifecycle.maintenance(()=>this.scope(scope));
    if(this.lifecycle.mode==='deleted') {if(action==='delete')return Response.json({deleted:true});throw new Error('Environment was deleted');}
    if(action==='resume'){
      this.lifecycle.transition('active',operation);
      const builder=(this.ctx.exports as unknown as {PluginBuilderDO?:DurableObjectNamespace<import('../../package-install/src/builder.ts').PluginBuilderDO>}).PluginBuilderDO;
      if(typeof builder?.getByName==='function')await builder.getByName(this.ctx.id.toString()).activate(operation);
      const at=await this.ctx.storage.get<number>('weft_paused_alarm');
      if(at!==undefined){await this.ctx.storage.setAlarm(Math.max(at,Date.now()+1000));await this.ctx.storage.delete('weft_paused_alarm');}
      return Response.json({resumed:true});
    }
    const at=await this.lifecycle.raw.getAlarm();
    this.lifecycle.transition('suspended',operation);
    return this.lifecycle.maintenance(async()=>{
      if(at!==null && await this.ctx.storage.get('weft_paused_alarm')===undefined)await this.ctx.storage.put('weft_paused_alarm',at);
      this.nativeEvents.close();this.nativeControl.close();this.lifecycle.closeStreams();
      await this.environmentPackages?.dispose();this.environmentPackages=undefined;
      await this.nativeWorkspaces?.dispose();this.nativeWorkspaces=undefined;
      await this.nativeSearch?.dispose();this.nativeSearch=undefined;
      await this.market?.dispose();this.market=undefined;
      await this.modelWorld?.dispose();this.modelWorld=undefined;
      const builder=(this.ctx.exports as unknown as {PluginBuilderDO?:DurableObjectNamespace<import('../../package-install/src/builder.ts').PluginBuilderDO>}).PluginBuilderDO;
      if(typeof builder?.getByName==='function')await builder.getByName(this.ctx.id.toString()).retire(operation);
      await this.lifecycle.drain();await this.ctx.storage.deleteAlarm();
      if(action==='delete'){for(const row of this.packages(scope).registry.list())this.ctx.facets.delete(environmentFacetName(row.name));if(this.ctx.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE name='weft_environment_plugin_facets'").toArray().length)for(const row of this.ctx.storage.sql.exec<{name:string}>('SELECT name FROM weft_environment_plugin_facets'))this.ctx.facets.delete(environmentFacetName(row.name));await this.lifecycle.purge(operation);return Response.json({deleted:true});}
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_resources (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT');
      const resources=this.ctx.storage.sql.exec<{kind:string;id:string}>('SELECT kind,id FROM weft_environment_resources').toArray();
      const records=this.sessions().list();
      const sessions=[...new Set([...records.map(row=>row.id),...resources.filter(row=>row.kind==='session').map(row=>row.id)])];
      const volumes=[...new Set(['default',...records.map(row=>row.workspaceId),...resources.filter(row=>row.kind==='workspace').map(row=>row.id)])];
      for(const root of sessions)this.ctx.storage.sql.exec("INSERT OR IGNORE INTO weft_environment_resources VALUES ('session',?)",root);
      for(const volume of volumes)this.ctx.storage.sql.exec("INSERT OR IGNORE INTO weft_environment_resources VALUES ('workspace',?)",volume);
      this.lifecycle.transition('suspended',operation,true);
      return Response.json({sessions,volumes});
    });
  }
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
        // An installed entry's configuration restarts its activations with the new value.
        if (event === 'settings/document-updated' && isEntryNamespace(String(args[0]))) {
          this.nativeEvents.emit('plugin-manager/changed', [{reason: 'plugin'}]);
          this.ctx.waitUntil(this.reconcileEnvironmentPackages(scope));
        }
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
      packageEntries: () => this.packages(scope).registry.list().flatMap(row => row.needsReinstall ? [] : (row.configs ?? []).map(entry => {
        const config = bundleLeaves(row.rows).find(leaf => leaf.id === entry.id)?.config;
        return {id: entryNamespace(row.name, entry.id), schema: entry.schema, base: config !== null && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {}};
      })),
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
  /** Persist a retryable, configuration-only cut beside the committed file snapshot. */
  private readonly copyCaptures=new Map<string,Promise<Response>>();
  private copySnapshots:DurableCopySnapshots|undefined;
  private snapshotStore():DurableCopySnapshots {return this.copySnapshots??=new DurableCopySnapshots(this.ctx.storage);}
  nativeCopySnapshot(scope: ControlScope, copyId: string): Promise<Response> {
    this.scope(scope);id.parse(copyId);
    let pending=this.copyCaptures.get(copyId);
    if(!pending) {
      pending=this.captureCopy(scope,copyId);this.copyCaptures.set(copyId,pending);
      void pending.finally(()=>this.copyCaptures.delete(copyId)).catch(()=>{});
    }
    return pending.then(response=>response.clone());
  }
  private async captureCopy(scope: ControlScope, copyId: string): Promise<Response> {
    this.scope(scope); id.parse(copyId);
    const saved=this.snapshotStore().get(copyId);
    if(saved) return Response.json(JSON.parse(saved));
    await this.syncSettingsDocument(scope);
    const workspaces=await this.workspaces(scope).configuration();
    const revision=this.settings(scope).revision;
    const data: EnvironmentCopyConfiguration={version:1,configuration:this.settings(scope).document(),presets:this.agents().current(),
      seeds:this.ctx.storage.sql.exec<{id:string;revision:number}>('SELECT id,revision FROM official_preset_seeds').toArray(),workspaces,
      bundles:this.officialBundles().list(),packages:this.packages(scope).registry.list(),clients:(await this.state(scope)).clientPlugins};
    const volume=this.documentVolume(scope),files=this.env.WORKSPACES.getByName(workspaceAddress(volume));
    // If capture died before publishing its configuration receipt, no importer
    // could have consumed it. Discard that orphan cut before taking a new one.
    await files.copySnapshot(volume,copyId,'release');
    const {count}=await (await files.copySnapshot(volume,copyId,'capture')).json() as {count:number};
    await this.packages(scope).snapshotArtifacts({...scope,environmentId:copyId},data.packages);
    const currentWorkspaces=await this.workspaces(scope).configuration(),currentClients=(await this.state(scope)).clientPlugins;
    if(this.settings(scope).revision!==revision || JSON.stringify(currentWorkspaces)!==JSON.stringify(workspaces) || JSON.stringify(currentClients)!==JSON.stringify(data.clients) || JSON.stringify(this.officialBundles().list())!==JSON.stringify(data.bundles) || JSON.stringify(this.packages(scope).registry.list())!==JSON.stringify(data.packages)) {
      await files.copySnapshot(volume,copyId,'release');
      throw new Error('Environment configuration changed during snapshot creation; retry the copy');
    }
    const value={data,count};
    this.snapshotStore().put(copyId,JSON.stringify(value));
    await this.ctx.storage.sync();
    return Response.json(value);
  }
  async nativeCopyImport(scope: ControlScope, text: string): Promise<void> {
    this.scope(scope);
    const data=JSON.parse(text) as EnvironmentCopyConfiguration;
    if(data.version!==1) throw new Error('Unsupported environment configuration snapshot');
    // Target is unpublished while these idempotent service imports run.
    await this.packages(scope).copyFrom(scope,data.packages);
    this.ctx.storage.transactionSync(()=>{
      for(const row of data.presets) this.agents().publish(row.spec.id,row);
      // Default seeded revision may already exist: replace it with the source's
      // exact current declaration; no Sessions exist in a provisioning target.
      for(const row of data.presets) this.ctx.storage.sql.exec('UPDATE weft_agent_revisions SET document=? WHERE agent_id=? AND revision=?',JSON.stringify(row),row.spec.id,row.revision);
      for(const seed of data.seeds) this.ctx.storage.sql.exec('INSERT INTO official_preset_seeds VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',seed.id,seed.revision);
      this.officialBundles().importConfiguration(data.bundles);
      for(const row of data.clients) {
        const module=compileClientPlugin(row.source);
        const document=JSON.stringify({...row,enabled:false});
        this.ctx.storage.sql.exec('INSERT INTO client_revisions VALUES (?,?,?) ON CONFLICT(revision) DO UPDATE SET document=excluded.document,module=excluded.module',row.revision,document,module);
        this.ctx.storage.sql.exec('INSERT INTO client_plugins VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=0',row.id,row.revision);
      }
    });
    await this.settings(scope).replaceDocument(data.configuration);
    await this.workspaces(scope).importConfiguration(data.workspaces);
    await this.writeSettingsDocument(scope);
    await this.ctx.storage.sync();
  }
  async nativeCopyRelease(scope: ControlScope, copyId: string): Promise<void> {
    return this.lifecycle.maintenance(async()=>{
    this.scope(scope);id.parse(copyId);if(this.lifecycle.mode==='deleted')return;
    await this.copyCaptures.get(copyId)?.catch(()=>undefined);
    const volume=this.documentVolume(scope);
    await this.env.WORKSPACES.getByName(workspaceAddress(volume)).releaseCopy(volume,copyId);
    this.snapshotStore().delete(copyId);
    });
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
    const harnessHome = await this.nativeHarnessHome(scope);
    const settings = this.settings(scope);
    const revision = settings.revision;
    if (knownRevision === revision) return Response.json({unchanged: true, revision});
    const models = settings.modelSections();
    const providers = models.piAi.providers !== null && typeof models.piAi.providers === 'object' ? Object.keys(models.piAi.providers) : [];
    const refs = new Set(['deepseek-official', ...providers].flatMap(provider => credentialRefFor(models as EnvironmentModels, provider) ?? []));
    const credentials: Record<string, boolean> = {};
    for (const ref of refs) {
      try { credentials[ref] = settings.credentials.configuredLocally(credentialRef(ref)); }
      catch { credentials[ref] = false; }
    }
    const permission = settings.value(PERMISSION_NAMESPACE).defaultPreset;
    const context: NativeSessionContext = {
      revision,
      models, credentials, harnessHome,
      loop: settings.value(LOOP_NAMESPACE) as {maxParallelToolCalls: number}, subagents: settings.value(SUBAGENT_NAMESPACE),
      ...(typeof permission === 'string' ? {permissionDefault: permission} : {}),
      profileOverrides: settings.profileOverrides(),
      profileEnablement: settings.profileEnablement(),
      workspaceRuntime: settings.value(WORKSPACE_RUNTIME_NAMESPACE) as NativeSessionContext['workspaceRuntime'],
      pluginPlan: settings.pluginPlan(),
      mcpServers: settings.value(MCP_NAMESPACE).servers as NativeSessionContext['mcpServers'],
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
        try {
          const plugin = await platform.evaluate(context, 'inspect:'+artifact.name, runId, '', () => () => {}, {module: artifact.host, services: [...workerHostServices]});
          const inject = Object.keys(plugin.inject ?? {});
          const background = inject.some(name => (environmentHostServices as readonly string[]).includes(name));
          artifact.hostScope = background ? 'environment' : 'session';
          artifact.permissions = {...artifact.permissions, network: true,
            storage: inject.some(name => name === 'storage' || name === 'storageDomain'), sessions: inject.includes('sessionController') || inject.includes('weftSessionEvents') || inject.includes('webhookRuntime'),
            credentials: inject.includes('credentials'), routes: inject.includes('webServer'), tools:inject.includes('tools'), background};
          const configs = entrySchemasSchema.parse(await platform.configSchemas(runId));
          if (configs.length) artifact.configs = configs; else delete artifact.configs;
        } finally {await platform.release(runId, true); await context.fiber.dispose();}
      },
      changed: async () => {this.presetReads.clear(); await this.nativeEvent(scope, 'plugin-manager/changed', [{reason: 'install'}]); this.ctx.waitUntil(this.reconcileEnvironmentPackages(scope));},
      alarm: at => this.requestPackageAlarm(at),
      revoke: async name => {
        await this.environmentPackages?.stop(name);
        this.ctx.facets.abort(environmentFacetName(name), new Error('Background package was revoked'));
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
  private environmentPackages: EnvironmentPackages | undefined;
  private backgroundPackages(scope: ControlScope): EnvironmentPackages {
    this.scope(scope);
    return this.environmentPackages ??= new EnvironmentPackages({state: this.ctx, loader: (this.env as HarnessEnvironment & {LOADER?: WorkerLoader}).LOADER, scope,
      list: () => this.runtimeInstallations(scope), artifact: (name, digest) => this.packages(scope).artifact(name, digest),
      capability: row => {
        const exports = this.ctx.exports as unknown as {EnvironmentPluginCapabilities(options: {props: {scope: ControlScope; name: string; digest: string; activationId: string}}): Fetcher};
        return exports.EnvironmentPluginCapabilities({props: {scope, name: row.name, digest: row.digest, activationId: row.activationId ?? row.digest}});
      },
      failed: async (row, reason) => {await this.packages(scope).failed(row.name, row.digest, 'host', row.activationId, reason);},
    });
  }
  private async requestPackageAlarm(at: number): Promise<void> {
    const previous = await this.ctx.storage.getAlarm();
    if (previous === null || previous <= Date.now() || previous > at) await this.ctx.storage.setAlarm(at);
  }
  private async schedulePackageAlarm(scope: ControlScope): Promise<void> {
    const next = await this.environmentPackages?.nextAlarm();
    const recovering = this.packages(scope).registry.jobs().some(row => row.phase === 'resolving' || row.phase === 'building') || this.packages(scope).registry.list().some(row => row.switching);
    // Outbound sockets and long polls do not survive eviction or a deploy; the
    // watchdog re-activates networked Hosts, which reconnect on their own.
    const watchdog = this.environmentPackages?.networked() ? [Date.now() + PACKAGE_WATCHDOG_MS] : [];
    const due = [next, ...watchdog, ...(recovering ? [Date.now() + 150_000] : [])].filter((value): value is number => value !== undefined);
    if (due.length) await this.requestPackageAlarm(Math.max(Date.now() + 1000, Math.min(...due)));
  }
  private async reconcileEnvironmentPackages(scope: ControlScope): Promise<void> {
    if (this.lifecycle.mode !== 'active') return;
    await this.backgroundPackages(scope).reconcile();
    await this.schedulePackageAlarm(scope);
  }
  nativePackageAuthorize(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, permission: 'network' | 'sessions' | 'credentials' | 'files' | 'routes' | 'tools'): Installation {
    this.scope(scope);
    const row = this.packages(scope).registry.get(receipt.name);
    if (!row?.enabled || !row.approved || row.digest !== receipt.digest || (row.activationId ?? row.digest) !== receipt.activationId || row.hostScope !== 'environment' || !row.permissions.background) throw new Error('Background package capability was revoked');
    if (permission === 'files' ? row.permissions.files === 'none' : !row.permissions[permission]) throw new Error('Plugin permission denied: ' + permission);
    return row;
  }
  private readonly webhookOperations=new Map<string,AbortController>();
  private readonly cancelledWebhooks=new Set<string>();
  private webhookOperation(receipt:{name:string;activationId:string},operationId:string):string {return JSON.stringify([receipt.name,receipt.activationId,z.uuid().parse(operationId)]);}
  async nativePackageDispatchWebhook(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},raw:unknown):Promise<void> {
    this.nativePackageAuthorize(scope,receipt,'sessions');const delivery=webhookDelivery.parse(raw);
    if(new TextEncoder().encode(JSON.stringify(delivery)).byteLength>1_048_576)throw new Error('Webhook delivery exceeds 1 MiB');
    await this.backgroundPackages(scope).reconcile();this.nativePackageAuthorize(scope,receipt,'sessions');
    await this.backgroundPackages(scope).dispatchWebhook(delivery);
  }
  async nativePackageCancelWebhook(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},operationId:string):Promise<void> {
    this.scope(scope);const key=this.webhookOperation(receipt,operationId);const active=this.webhookOperations.get(key);
    if(active)active.abort();else {this.cancelledWebhooks.add(key);if(this.cancelledWebhooks.size>128)this.cancelledWebhooks.delete(this.cancelledWebhooks.values().next().value!);}
  }
  nativePackageCheckWebhook(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},operationId:string):void {
    this.nativePackageAuthorize(scope,receipt,'sessions');const active=this.webhookOperations.get(this.webhookOperation(receipt,operationId));
    if(!active)throw new Error('Webhook action is no longer active');active.signal.throwIfAborted();
  }
  async nativePackageCreateWebhook(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},operationId:string,rawDelivery:unknown,ruleId:string,rawRequest:unknown):Promise<void> {
    this.nativePackageAuthorize(scope,receipt,'sessions');
    const delivery=webhookDelivery.parse(rawDelivery),request=webhookSessionRequest.parse(rawRequest);z.string().trim().min(1).max(200).parse(ruleId);
    const key=this.webhookOperation(receipt,operationId);if(this.webhookOperations.has(key))throw new Error('Webhook action already active');
    if(this.webhookOperations.size>=32)throw new Error('Too many active webhook actions');
    const abort=new AbortController();this.webhookOperations.set(key,abort);if(this.cancelledWebhooks.delete(key))abort.abort();
    const check=()=>{abort.signal.throwIfAborted();this.nativePackageAuthorize(scope,receipt,'sessions');};
    let sessionId:string|undefined,workspaceId:string|undefined,created=false,published=false,phase='preflight';
    try {
      check();
      const profile=await this.nativeProfile(scope,request.agentPreset);if(!(await profile.json() as {value?:unknown}).value)throw new Error('Webhook Agent preset is unavailable');
      const permissions=await openPermissionWorld(undefined);
      try {permissions.ctx.permissionPresets.resolve(request.permissionPreset);}finally{await permissions.ctx.fiber.dispose();}
      phase='workspace';check();const workspace=await this.nativeResolveWorkspace(scope,undefined,request.workspacePath);workspaceId=workspace.workspaceId;
      phase='create';check();sessionId='webhook-'+crypto.randomUUID();const address={...scope,sessionId},target=this.env.SESSIONS.getByName(sessionAddress(address));
      created=await target.nativeCreate(address,{id:request.agentPreset},'default',workspace.path,{actionId:operationId,delivery,ruleId,request});
      if(!created)throw new Error('Webhook Session identity is unavailable');check();
      phase='attach';await this.nativeAttachWorkspace(scope,workspace.workspaceId,sessionId);check();
      phase='admit';await target.nativeWebhookAdmit(address,receipt,operationId);published=true;
    } catch(error) {console.warn('weft.webhook.action.failed',{phase,code:error instanceof RemoteError?error.code:error instanceof Error?error.name:'unknown'});throw error;} finally {
      this.webhookOperations.delete(key);
      if(!published&&sessionId && await this.env.SESSIONS.getByName(sessionAddress({...scope,sessionId})).nativeWebhookOwned({...scope,sessionId},operationId)){
        const address={...scope,sessionId};
        await this.env.SESSIONS.getByName(sessionAddress(address)).nativeLifecycle(address,'delete',1);
        if(workspaceId)await this.workspaces(scope).detach(workspaceId,sessionId);
        this.sessionRecords?.remove(sessionId);this.summaryStore().remove(sessionId);
      }
    }
  }
  async nativePackageTools(scope:ControlScope,receipt:{name:string;digest:string;activationId:string}):Promise<unknown> {
    this.nativePackageAuthorize(scope,receipt,'tools');
    const tools=await this.backgroundPackages(scope).tools(receipt.name,receipt.digest,receipt.activationId);
    this.nativePackageAuthorize(scope,receipt,'tools');return tools;
  }
  async nativePackageTool(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},sessionId:string,raw:unknown):Promise<unknown> {
    this.nativePackageAuthorize(scope,receipt,'tools');
    if(this.nativeSessionRoot(scope,id.parse(sessionId))!==sessionId)throw new Error('Tool caller is outside this environment');
    const request=z.object({name:z.string().min(1).max(100),args:z.unknown(),callId:z.string().min(1).max(200),operationId:z.uuid()}).strict().parse(raw);
    const value=await this.backgroundPackages(scope).tool(receipt.name,receipt.digest,receipt.activationId,request.name,request.args,request.callId,sessionId+':'+request.operationId);
    this.nativePackageAuthorize(scope,receipt,'tools');return value;
  }
  async nativePackageToolCancel(scope:ControlScope,receipt:{name:string;digest:string;activationId:string},sessionId:string,operationId:string):Promise<void> {
    this.scope(scope);id.parse(sessionId);z.uuid().parse(operationId);
    await this.environmentPackages?.cancelTool(receipt.name,receipt.digest,receipt.activationId,sessionId+':'+operationId);
  }
  async nativePackageCredential(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, ref: string): Promise<unknown> {
    this.nativePackageAuthorize(scope, receipt, 'credentials');
    const value = await this.settings(scope).credentials.resolve(credentialRef(ref));
    this.nativePackageAuthorize(scope, receipt, 'credentials');
    return value;
  }
  async nativePackageFs(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, method: string, args: unknown[]): Promise<unknown> {
    const row = this.nativePackageAuthorize(scope, receipt, 'files');
    const {nativePluginFsMethods} = await import('../../native-plugins/src/protocol.ts');
    if (!(nativePluginFsMethods as readonly string[]).includes(method) || row.permissions.files === 'read' && ['writeText','editText'].includes(method)) throw new Error('Plugin filesystem permission denied');
    const ctx = new Context();
    try {
      const volume = {...scope, workspaceId: 'default'};
      await ctx.plugin(ComputerFileSystem, {scope: volume, transport: this.env.WORKSPACES.getByName(workspaceAddress(volume)), cwd: '/workspace'}).await();
      this.nativePackageAuthorize(scope, receipt, 'files');
      return await Reflect.apply(Reflect.get(ctx.fs, method), ctx.fs, z.array(z.unknown()).max(5).parse(args));
    } finally {await ctx.fiber.dispose();}
  }
  async nativePackageHook(scope: ControlScope, name: string, request: Request): Promise<Response> {
    this.scope(scope);
    const row = this.packages(scope).registry.get(name);
    if (!row?.enabled || !row.approved || row.hostScope !== 'environment' || !row.permissions.background || !row.permissions.routes) return new Response(null,{status:404});
    this.nativePackageAuthorize(scope, {name,digest:row.digest,activationId:row.activationId ?? row.digest}, 'routes');
    const response = await this.backgroundPackages(scope).fetch(name, request);
    await this.schedulePackageAlarm(scope);
    return response;
  }
  /** Record one package's interest in a root Session's turn ends; see docs/architecture/session-turn-notifications.md. */
  nativePackageWatchSession(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, sessionId: string, watch: boolean): void {
    this.nativePackageAuthorize(scope, receipt, 'sessions'); id.parse(sessionId);
    if (!watch) {this.ctx.storage.sql.exec('DELETE FROM weft_session_watches WHERE package=? AND session_id=?', receipt.name, sessionId); return;}
    if (this.nativeSessionRoot(scope, sessionId) !== sessionId) throw new Error('Session is outside this environment');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO weft_session_watches (package, session_id) VALUES (?, ?)', receipt.name, sessionId);
  }
  /** A root Session finished a turn. Best-effort: watchers recover a missed hint from their own cursor. */
  async nativeSessionTurnEnded(scope: ControlScope, sessionId: string, seq: number): Promise<void> {
    this.scope(scope); id.parse(sessionId);
    if (this.lifecycle.mode !== 'active' || !Number.isSafeInteger(seq) || seq < 0) return;
    const watching = this.ctx.storage.sql.exec<{package: string}>('SELECT package FROM weft_session_watches WHERE session_id=?', sessionId).toArray().map(row => row.package);
    if (!watching.length) return;
    // Removal leaves watches behind; they lapse here instead of in every uninstall path.
    const installed = new Set(this.packages(scope).registry.list().map(row => row.name));
    for (const name of watching.filter(name => !installed.has(name))) this.ctx.storage.sql.exec('DELETE FROM weft_session_watches WHERE package=?', name);
    const live = watching.filter(name => installed.has(name));
    if (live.length) await this.backgroundPackages(scope).dispatchSessionEvent(live, {sessionId, seq});
  }
  async nativePackageFollow(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, raw: unknown): Promise<Response> {
    this.nativePackageAuthorize(scope, receipt, 'sessions');
    const {request} = sessionRemote.methods['session/follow'].input({strict: true}).create().parse({request: raw});
    if (request.address.kind !== 'session' || this.nativeSessionRoot(scope, request.address.sessionId) !== request.address.sessionId) throw new Error('Session stream is outside this environment');
    const address = {...scope, sessionId: request.address.sessionId};
    const response = await this.env.SESSIONS.getByName(sessionAddress(address)).fetch(new Request('https://session.internal/native-follow', {
      method: 'POST', body: JSON.stringify({scope: address, operation: 'native-follow', args: {request}}),
    }));
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {this.nativePackageAuthorize(scope, receipt, 'sessions'); const part = await reader.read(); this.nativePackageAuthorize(scope, receipt, 'sessions'); if (part.done) controller.close(); else controller.enqueue(part.value);}
        catch (error) {controller.error(error); await reader.cancel().catch(() => {});}
      }, cancel: () => reader.cancel(),
    }, {highWaterMark: 0});
    return new Response(body, {status: response.status, headers: response.headers});
  }
  async nativePackageSession(scope: ControlScope, receipt: {name: string; digest: string; activationId: string}, method: string, raw: unknown): Promise<unknown> {
    this.nativePackageAuthorize(scope, receipt, 'sessions');
    if (method === 'modelCatalog') {
      sessionRemote.methods['session/modelCatalog'].input({strict: true}).create().parse(raw);
      const {value} = await (await this.nativeModelRemote(scope, 'session/modelCatalog', raw)).json() as {value: unknown};
      return value;
    }
    if (method === 'list') {
      sessionRemote.methods['session/list'].input({strict: true}).create().parse({_request: raw});
      return (await this.nativeSessionList(scope)).json();
    }
    if (method === 'create') {
      const {request} = sessionRemote.methods['session/create'].input({strict: true}).create().parse({request: raw});
      const workspace = await this.nativeResolveWorkspace(scope, request.workspaceId, request.cwd);
      let sessionId = request.sessionId ?? crypto.randomUUID();
      const existingOwner = this.nativeSessionRoot(scope, sessionId);
      if (existingOwner && existingOwner !== sessionId) sessionId = crypto.randomUUID();
      let address = {...scope, sessionId};
      let target = this.env.SESSIONS.getByName(sessionAddress(address));
      this.nativePackageAuthorize(scope, receipt, 'sessions');
      if (!await target.nativeCreate(address, request.agentPreset === undefined ? undefined : {id: request.agentPreset}, 'default', workspace.path)) {
        sessionId = crypto.randomUUID(); address = {...scope, sessionId}; target = this.env.SESSIONS.getByName(sessionAddress(address));
        if (!await target.nativeCreate(address, request.agentPreset === undefined ? undefined : {id: request.agentPreset}, 'default', workspace.path)) throw new Error('Session identity already exists');
      }
      await this.nativeAttachWorkspace(scope, workspace.workspaceId, sessionId);
      return {sessionId};
    }
    const value = z.object({sessionId: z.string().optional(), address: z.object({kind: z.literal('session'), sessionId: z.string()}).optional()}).passthrough().parse(raw);
    const sessionId = id.parse(value.sessionId ?? value.address?.sessionId);
    if (this.nativeSessionRoot(scope, sessionId) !== sessionId) throw new Error('Session is outside this environment or is not a root Session');
    const address = {...scope, sessionId};
    const target = this.env.SESSIONS.getByName(sessionAddress(address));
    if (method === 'selectModel') {
      const {request} = sessionRemote.methods['session/selectModel'].input({strict: true}).create().parse({request: raw});
      // Bot-specific selection must not change the environment's default model.
      return (await target.nativeSelectModel(address, request, false)).json();
    }
    if (method === 'prompt') {
      const {request} = sessionRemote.methods['session/prompt'].input({strict: true}).create().parse({request: raw});
      await target.nativePrompt(address, request); return {accepted: true};
    }
    if (method === 'cancel') {
      sessionRemote.methods['session/cancel'].input({strict: true}).create().parse({request: raw});
      await target.nativeCancel(address); return {accepted: true};
    }
    if (method === 'rename') {
      const {request} = sessionRemote.methods['session/rename'].input({strict: true}).create().parse({request: raw});
      return target.nativeRename(address, request.title);
    }
    if (method === 'page') return (await target.nativePage(address, raw)).json();
    if (method === 'projections') {
      sessionRemote.methods['session/projections'].input({strict: true}).create().parse({request: raw});
      return (await target.nativeProjections(address)).json();
    }
    throw new Error('Session Controller method is not bridged: ' + method);
  }
  async nativePackageList(scope: ControlScope): Promise<Response> {return Response.json(this.packages(scope).list(), {headers: {'cache-control': 'private, no-store'}});}
  /** Installations with the environment's configuration of their entries, for activations only. */
  private runtimeInstallations(scope: ControlScope): Installation[] {
    const settings = this.settings(scope);
    return this.packages(scope).registry.list().map(row => {
      const config = Object.fromEntries((row.configs ?? []).flatMap(entry => {
        const user = settings.user(entryNamespace(row.name, entry.id));
        return Object.keys(user).length ? [[entry.id, user]] : [];
      }));
      return Object.keys(config).length ? {...row, config} : row;
    });
  }
  async nativePackageRuntime(scope: ControlScope): Promise<Installation[]> {return this.runtimeInstallations(scope);}
  async nativePackageArtifact(scope: ControlScope, name: string, digest: string, client = false): Promise<Response> {
    const packages = this.packages(scope);
    if (client && !packages.registry.get(name)?.permissions.client) throw new Error('Client module permission is not granted');
    return Response.json(await packages.artifact(name, digest));
  }
  async nativePackageResource(scope: ControlScope, digest: string, path: string, name?: string): Promise<Response> {
    const packages = this.packages(scope);
    const row = packages.registry.list().find(row => row.digest === digest && (!name || row.name === name));
    if (!row?.permissions.client) throw new Error('Client module permission is not granted');
    const artifact = await packages.artifact(row.name, digest);
    if (!packages.registry.get(row.name)?.permissions.client) throw new Error('Client module permission is not granted');
    const headers = {'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin'};
    if (path === 'client.js' && artifact.client) return new Response(artifact.client, {headers: {...headers, 'content-type':'text/javascript; charset=utf-8'}});
    if (path === 'client.css' && artifact.css !== undefined) return new Response(artifact.css, {headers: {...headers, 'content-type':'text/css; charset=utf-8'}});
    const {assetPath, assetTypes} = await import('../../package-install/src/contracts.ts');
    const value = artifact.assets?.[path];
    if (!assetPath.test(path) || value === undefined) return new Response(null, {status:404, headers});
    const extension = path.slice(path.lastIndexOf('.') + 1) as keyof typeof assetTypes;
    return new Response(Uint8Array.from(atob(value), char=>char.charCodeAt(0)), {headers: {...headers, 'content-type':assetTypes[extension], 'content-security-policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'"}});
  }
  async nativePackageFailure(scope: ControlScope, name: string, digest: string, activationId?: string): Promise<boolean> {
    return this.packages(scope).failed(name, digest, 'host', activationId);
  }
  async nativePackageOperation(scope: ControlScope, raw: unknown): Promise<Response> {
    const request = z.discriminatedUnion('operation', [
      z.object({operation: z.literal('list')}).strict(),
      z.object({operation: z.literal('install'), spec: z.string().max(250), requestId: z.string().max(100)}).strict(),
      z.object({operation: z.literal('approve'), name: z.string().max(214), digest: z.string().regex(/^[a-f0-9]{64}$/), permissions: permissionSchema.optional()}).strict(),
      z.object({operation: z.literal('review'), name: z.string().max(214), digest: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
      ...(['rollback','discard'] as const).map(operation => z.object({operation: z.literal(operation), name: z.string().max(214), digest: z.string().regex(/^[a-f0-9]{64}$/)}).strict()),
      z.object({operation:z.literal('client-failed'), name:z.string().max(214), digest:z.string().regex(/^[a-f0-9]{64}$/),activationId:z.uuid().optional()}).strict(),
    ]).parse(raw);
    const packages = this.packages(scope);
    if (request.operation === 'install') return Response.json(await packages.start(request.spec, request.requestId), {status: 202});
    if (request.operation === 'approve') {await packages.approve(request.name, request.digest, request.permissions); return Response.json({ok: true});}
    if (request.operation === 'review') return Response.json(await packages.artifact(request.name, request.digest, false));
    if (request.operation === 'rollback') {await packages.rollback(request.name, request.digest); return Response.json({ok:true});}
    if (request.operation === 'discard') {await packages.discard(request.name, request.digest); return Response.json({ok:true});}
    if (request.operation === 'client-failed') return Response.json({changed:await packages.failed(request.name, request.digest, 'client', request.activationId)});
    return Response.json(packages.list());
  }
  override async alarm(): Promise<void> {
    if (this.lifecycle.mode !== 'active') return;
    await this.lifecycle.run(async () => {
      const scope = environmentScopeOf(this.ctx.id.name);
      await this.packages(scope).recover();
      await this.backgroundPackages(scope).tick();
      await this.schedulePackageAlarm(scope);
    });
  }
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
        if (endpoint === 'pluginManager/listBundles') result.value = [...result.value as unknown[], ...packages.bundles(), ...bundledPackageInfo(name => packages.get(name) !== undefined), ...optionalBundleInfo(bundleStates), ...environmentPlugins.bundles(readConfig)];
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
  /** Missing, running or resident-Agent roots require a source RPC; stable idle summaries are local. */
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
    const lifecycle=new LifecycleGate(ctx.storage);
    super(ctx, env);
    this.ctx=lifecycle.state(this.ctx);ctx=this.ctx;
    this.lifecycle=lifecycle;
    if(lifecycle.mode==='deleted'){lifecycle.finishBoot();return;}
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
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_session_watches (package TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(package, session_id)) STRICT');
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_plugins (id TEXT PRIMARY KEY, revision TEXT NOT NULL, enabled INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_revisions (revision TEXT PRIMARY KEY, document TEXT NOT NULL, module TEXT NOT NULL)",
    );
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_harness_home (id INTEGER PRIMARY KEY CHECK (id = 1), anonymous_user_id TEXT NOT NULL)');
    lifecycle.finishBoot();
    if(lifecycle.mode==='active')this.ctx.waitUntil(Promise.resolve().then(()=>this.reconcileEnvironmentPackages(environmentScopeOf(this.ctx.id.name))));
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
/** How soon a networked environment Host is re-activated after this object restarts. */
const PACKAGE_WATCHDOG_MS = 60_000;
export class TenantDO extends DurableObject<TenantEnvironment> {
  private copyWork: Promise<void> | undefined;
  private readonly localRelay:LocalHostRelay;
  constructor(ctx: DurableObjectState, env: TenantEnvironment) {
    super(ctx,env);
    this.localRelay=new LocalHostRelay(ctx);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_local_hosts (id TEXT PRIMARY KEY,pair_hash TEXT,pair_expires INTEGER,token_hash TEXT) STRICT');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_copy_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, cleanup INTEGER NOT NULL DEFAULT 0) STRICT');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_lifecycle_jobs (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,complete INTEGER NOT NULL,document TEXT NOT NULL) STRICT');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_lifecycle_sequence (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL) STRICT');
  }
  private async writeCatalogue(tenantId:string,record:EnvironmentRecord):Promise<void> {
    await this.env.CONFIG_DB.prepare('INSERT INTO environments (tenant_id,environment_id,document) VALUES (?,?,?) ON CONFLICT(tenant_id,environment_id) DO UPDATE SET document=excluded.document').bind(tenantId,record.id,JSON.stringify(record)).run();
    const rows=await this.environmentRows(tenantId);
    this.registry=Promise.resolve(rows.some(row=>row.id===record.id)?rows.map(row=>row.id===record.id?structuredClone(record):row):[...rows,structuredClone(record)]);
  }
  async renameEnvironment(tenantId:string,environmentId:string,input:unknown):Promise<Response> {
    this.scope(tenantId);id.parse(environmentId);
    const parsed=environmentRenameSchema.safeParse(input);if(!parsed.success)return Response.json({error:'环境名称无效'},{status:400});
    return this.serialized(async()=>{
      const record=(await this.environmentRows(tenantId)).find(row=>row.id===environmentId);
      if(!record||record.status==='deleted')return Response.json({error:'环境不存在'},{status:404});
      if(record.status && !['ready','paused'].includes(record.status))return Response.json({error:'请等待当前操作完成后再重命名'},{status:409});
      record.name=parsed.data.name;record.updatedAt=new Date().toISOString();
      const old=this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs WHERE id=?',record.id).toArray()[0];
      const job:EnvironmentLifecycleJob=old?JSON.parse(old.document):{tenantId,record,cursor:0};job.record=record;
      // Commit the rename before updating D1, so a cold recovery cannot restore
      // an older name from a completed copy/lifecycle journal.
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec('INSERT INTO weft_environment_lifecycle_jobs VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',record.id,record.lifecycle?.revision??0,JSON.stringify(job));
        this.ctx.storage.sql.exec('UPDATE weft_environment_copy_jobs SET document=? WHERE id=?',JSON.stringify({tenantId,record}),record.id);
      });
      await this.writeCatalogue(tenantId,record);
      return Response.json(record);
    });
  }
  private async saveLifecycle(job:EnvironmentLifecycleJob,complete=false):Promise<boolean> {
    return this.serialized(async()=>{
      const revision=job.record.lifecycle!.revision;
      if(!this.ctx.storage.sql.exec('SELECT id FROM weft_environment_lifecycle_jobs WHERE id=? AND revision=?',job.record.id,revision).toArray().length)return false;
      this.ctx.storage.sql.exec('UPDATE weft_environment_lifecycle_jobs SET complete=?,document=? WHERE id=? AND revision=?',Number(complete),JSON.stringify(job),job.record.id,revision);
      this.ctx.storage.sql.exec('UPDATE weft_environment_copy_jobs SET cleanup=0,document=? WHERE id=?',JSON.stringify({tenantId:job.tenantId,record:job.record}),job.record.id);
      await this.writeCatalogue(job.tenantId,job.record);return true;
    });
  }
  async lifecycleEnvironment(tenantId:string,environmentId:string,input:unknown):Promise<Response> {
    this.scope(tenantId);id.parse(environmentId);
    const parsed=environmentLifecycleSchema.safeParse(input);if(!parsed.success)return Response.json({error:'环境操作无效'},{status:400});
    const action=parsed.data.action;
    const response=await this.serialized(async()=>{
      const rows=await this.environmentRows(tenantId),record=rows.find(row=>row.id===environmentId);
      if(!record)return Response.json({error:'环境不存在'},{status:404});
      if(record.status==='deleted')return Response.json(record,{status:action==='delete'?200:410});
      if(record.kind==='local'){
        if(action!=='delete')return Response.json({error:'本地环境请在本机管理运行状态'},{status:409});
        this.localRelay.disconnect(environmentId);this.ctx.storage.sql.exec('DELETE FROM weft_local_hosts WHERE id=?',environmentId);
        record.status='deleted';record.updatedAt=new Date().toISOString();delete record.local;
        const journal=this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs WHERE id=?',environmentId).toArray()[0];
        if(journal){const job=JSON.parse(journal.document) as EnvironmentLifecycleJob;job.record=record;this.ctx.storage.sql.exec('UPDATE weft_environment_lifecycle_jobs SET document=?,complete=1 WHERE id=?',JSON.stringify(job),environmentId);}
        await this.writeCatalogue(tenantId,record);return Response.json(record);
      }
      if(action==='delete'&&environmentId==='default')return Response.json({error:'默认环境不能删除，可暂停或重命名'},{status:409});
      if(record.status==='copying'||rows.some(row=>row.status==='copying'&&row.copy?.sourceId===environmentId))return Response.json({error:'环境正在参与复制，请完成后重试'},{status:409});
      const pending=record.lifecycle&&(['pausing','resuming','deleting'].includes(record.status??'')||record.lifecycle.phase!=='done');
      if(pending){
        if(record.lifecycle!.action!==action)return Response.json({error:'请先完成当前环境操作'},{status:409});
        const stored=this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs WHERE id=?',environmentId).one();
        const job=JSON.parse(stored.document) as EnvironmentLifecycleJob;delete job.record.lifecycle!.error;
        this.ctx.storage.sql.exec('UPDATE weft_environment_lifecycle_jobs SET document=? WHERE id=?',JSON.stringify(job),environmentId);
        await this.writeCatalogue(tenantId,job.record);return Response.json(job.record,{status:202});
      }
      if((action==='suspend'&&record.status==='paused')||(action==='resume'&&(!record.status||record.status==='ready')))return Response.json(record);
      if(action!=='delete'&&record.status==='failed')return Response.json({error:'未完成的副本只能重试复制或删除'},{status:409});
      const revision=this.ctx.storage.sql.exec<{revision:number}>('INSERT INTO weft_lifecycle_sequence VALUES (1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1 RETURNING revision').one().revision;
      record.status=action==='suspend'?'pausing':action==='resume'?'resuming':'deleting';
      record.lifecycle={action,revision,phase:'environment'};record.updatedAt=new Date().toISOString();
      const job:EnvironmentLifecycleJob={tenantId,record,cursor:0};
      await this.ctx.storage.setAlarm(Date.now()+30_000);
      this.ctx.storage.sql.exec('INSERT INTO weft_environment_lifecycle_jobs VALUES (?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,complete=0,document=excluded.document',environmentId,revision,JSON.stringify(job));
      this.ctx.storage.sql.exec('UPDATE weft_environment_copy_jobs SET document=? WHERE id=?',JSON.stringify({tenantId,record}),environmentId);
      await this.writeCatalogue(tenantId,record);return Response.json(record,{status:202});
    });
    if(response.ok){await this.ctx.storage.setAlarm(Date.now()+30_000);this.launchCopies();}return response;
  }
  private async performLifecycle(job:EnvironmentLifecycleJob):Promise<void> {
    const {record,tenantId}=job,operation=record.lifecycle!,scope={tenantId,environmentId:record.id};
    const environment=this.env.ENVIRONMENTS.getByName(environmentAddress(scope));
    const next=async(phase:string)=>{operation.phase=phase;job.cursor=0;delete operation.error;return this.saveLifecycle(job);};
    try {
      if(operation.phase==='environment'){
        job.resources=await (await environment.nativeLifecycle(scope,'freeze',operation.revision)).json() as {sessions:string[];volumes:string[]};
        await next(operation.action==='resume'?'volumes':'sessions');return;
      }
      const resources=job.resources!;
      if(operation.phase==='sessions'||operation.phase==='wake'){
        const end=Math.min(job.cursor+8,resources.sessions.length);
        for(;job.cursor<end;job.cursor++){
          const address={...scope,sessionId:resources.sessions[job.cursor]!};
          await this.env.SESSIONS.getByName(sessionAddress(address)).nativeLifecycle(address,operation.phase==='wake'?'wake':operation.action==='delete'?'delete':operation.action==='resume'?'resume':'freeze',operation.revision);
        }
        if(job.cursor<resources.sessions.length){await this.saveLifecycle(job);return;}
        await next(operation.phase==='wake'?'done':operation.action==='resume'?'activate':'volumes');return;
      }
      if(operation.phase==='volumes'){
        const end=Math.min(job.cursor+4,resources.volumes.length);
        for(;job.cursor<end;job.cursor++){
          const address={...scope,workspaceId:resources.volumes[job.cursor]!};
          await this.env.WORKSPACES.getByName(workspaceAddress(address)).nativeLifecycle(address,operation.action==='delete'?'delete':operation.action==='resume'?'resume':'freeze',operation.revision);
        }
        if(job.cursor<resources.volumes.length){await this.saveLifecycle(job);return;}
        await next(operation.action==='resume'?'sessions':operation.action==='delete'?'artifacts':'done');return;
      }
      if(operation.phase==='activate'){await environment.nativeLifecycle(scope,'resume',operation.revision);await next('wake');return;}
      if(operation.phase==='artifacts'){
        if(record.copy){const original={tenantId,environmentId:record.copy.sourceId};await this.env.ENVIRONMENTS.getByName(environmentAddress(original)).nativeCopyRelease(original,record.id);}
        const prefix=`packages/${encodeURIComponent(JSON.stringify(scope))}/`,bucket=this.env.PLUGIN_ARTIFACTS;
        if(bucket){const page=await bucket.list({prefix,limit:128});if(page.objects.length){await bucket.delete(page.objects.map(row=>row.key));await this.saveLifecycle(job);return;}}
        await environment.nativeLifecycle(scope,'delete',operation.revision);await next('done');return;
      }
      if(operation.phase==='done'){
        record.status=operation.action==='delete'?'deleted':operation.action==='suspend'?'paused':'ready';record.updatedAt=new Date().toISOString();
        if(record.status==='deleted'){record.name='已删除环境';delete record.copy;}
        delete operation.error;delete job.resources;job.cursor=0;await this.saveLifecycle(job,true);
      }
    } catch(error){operation.error=(error instanceof Error?error.message:'环境操作失败').slice(0,500);await this.saveLifecycle(job);}
  }
  override async alarm(): Promise<void> {
    await this.copyWork?.catch(()=>{});
    await this.runCopyBatch();
  }
  private launchCopies(): void {
    this.ctx.waitUntil(this.runCopyBatch());
  }
  private runCopyBatch():Promise<void> {
    if(this.copyWork) return this.copyWork;
    const pending=this.recoverCopies(); this.copyWork=pending;
    void pending.finally(()=>{if(this.copyWork===pending)this.copyWork=undefined;}).catch(()=>{});
    return pending;
  }
  private async saveCopy(tenantId: string, record: EnvironmentRecord, cleanup=0): Promise<void> {
    await this.serialized(async ()=>{
      const current=(await this.environmentRows(tenantId)).find(row=>row.id===record.id);
      if(current?.lifecycle && (current.lifecycle.phase!=='done'||current.status!=='ready'))throw new Error('Environment copy is closed by a lifecycle operation');
      if(current){record.name=current.name;if(current.lifecycle)record.lifecycle=current.lifecycle;if(current.updatedAt>record.updatedAt)record.updatedAt=current.updatedAt;}
      this.ctx.storage.sql.exec('INSERT INTO weft_environment_copy_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,cleanup=excluded.cleanup',record.id,JSON.stringify({tenantId,record}),cleanup);
      await this.env.CONFIG_DB.prepare('INSERT INTO environments (tenant_id,environment_id,document) VALUES (?,?,?) ON CONFLICT(tenant_id,environment_id) DO UPDATE SET document=excluded.document').bind(tenantId,record.id,JSON.stringify(record)).run();
      const rows=await this.environmentRows(tenantId);
      this.registry=Promise.resolve(rows.some(row=>row.id===record.id)?rows.map(row=>row.id===record.id?structuredClone(record):row):[...rows,structuredClone(record)]);
    });
  }
  private async recoverCopies(): Promise<void> {
    try {
    const lifecycle=this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs WHERE complete=0 ORDER BY rowid LIMIT 1').toArray()[0];
    if(lifecycle){await this.performLifecycle(JSON.parse(lifecycle.document));return;}
    const jobs=this.ctx.storage.sql.exec<{document:string;cleanup:number}>('SELECT document,cleanup FROM weft_environment_copy_jobs WHERE cleanup=1 OR json_extract(document,\'$.record.status\')=\'copying\' ORDER BY cleanup,rowid LIMIT 1').toArray();
    for(const job of jobs) {
      const {tenantId,record}=JSON.parse(job.document) as {tenantId:string;record:EnvironmentRecord};
      if(job.cleanup) {await this.saveCopy(tenantId,record,1);await this.cleanupCopy(tenantId,record);continue;}
      if(record.status!=='copying' || !record.copy) continue;
      await this.ctx.storage.setAlarm(Date.now()+30_000);
      await this.performCopy(tenantId,record);
    }
    } finally {
      const lifecycle=this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs WHERE complete=0 ORDER BY rowid LIMIT 1').toArray()[0];
      if(lifecycle){const job=JSON.parse(lifecycle.document) as EnvironmentLifecycleJob;await this.ctx.storage.setAlarm(Date.now()+(job.record.lifecycle?.error?30_000:10));}
      else {
      const pending=this.ctx.storage.sql.exec<{cleanup:number}>('SELECT cleanup FROM weft_environment_copy_jobs WHERE cleanup=1 OR json_extract(document,\'$.record.status\')=\'copying\' ORDER BY cleanup,rowid LIMIT 1').toArray()[0];
      if(pending) await this.ctx.storage.setAlarm(Date.now()+(pending.cleanup?30_000:10));else await this.ctx.storage.deleteAlarm();
      }
    }
  }
  private async cleanupCopy(tenantId:string,record:EnvironmentRecord): Promise<void> {
    if(!record.copy) return;
    const scope={tenantId,environmentId:record.copy.sourceId};
    await this.env.ENVIRONMENTS.getByName(environmentAddress(scope)).nativeCopyRelease(scope,record.id);
    this.ctx.storage.sql.exec('UPDATE weft_environment_copy_jobs SET cleanup=0 WHERE id=?',record.id);
  }
  private async performCopy(tenantId:string,record:EnvironmentRecord): Promise<void> {
    const copy=record.copy!;
    const source={tenantId,environmentId:copy.sourceId},target={tenantId,environmentId:record.id};
    try {
      const origin=this.env.ENVIRONMENTS.getByName(environmentAddress(source));
      const count=copy.total || (await (await origin.nativeCopySnapshot(source,record.id)).json() as {count:number}).count;
      const sourceVolume={...source,workspaceId:'default'},targetVolume={...target,workspaceId:'default'};
      const from=this.env.WORKSPACES.getByName(workspaceAddress(sourceVolume)),to=this.env.WORKSPACES.getByName(workspaceAddress(targetVolume));
      let {next}=await (await to.copySnapshot(targetVolume,record.id,'next')).json() as {next:number};
      copy.phase='files';copy.total=count;copy.completed=next;delete copy.error;
      await this.saveCopy(tenantId,record);
      const end=Math.min(next+128,count);
      for(;next<end;next++) {
        const page=await from.copySnapshot(sourceVolume,record.id,'page',next);
        await to.copyAccept(targetVolume,record.id,next,page);
        copy.completed=next+1;
        if((next+1)%32===0) {await this.saveCopy(tenantId,record);await this.ctx.storage.setAlarm(Date.now()+30_000);}
      }
      if(next<count) {await this.saveCopy(tenantId,record);return;}
      copy.phase='configuration';await this.saveCopy(tenantId,record);
      const snapshot=await (await origin.nativeCopySnapshot(source,record.id)).json() as {data:EnvironmentCopyConfiguration;count:number};
      if(snapshot.count!==count)throw new Error('Environment copy snapshot changed unexpectedly');
      await this.env.ENVIRONMENTS.getByName(environmentAddress(target)).nativeCopyImport(target,JSON.stringify(snapshot.data));
      record.status='ready';record.updatedAt=new Date().toISOString();copy.phase='done';
      await this.saveCopy(tenantId,record,1);
      await this.cleanupCopy(tenantId,record);
    } catch(error) {
      // Cleanup errors after publication must never turn a usable target into a failed draft.
      if(record.status==='ready') {await this.ctx.storage.setAlarm(Date.now()+30_000);return;}
      record.status='failed';copy.error=(error instanceof Error?error.message:'Environment copy failed').slice(0,500);
      await this.saveCopy(tenantId,record);
    }
  }
  async copyEnvironment(tenantId:string,sourceId:string,input:unknown): Promise<Response> {
    this.scope(tenantId);id.parse(sourceId);
    const parsed=environmentCopySchema.safeParse(input);
    if(!parsed.success) return Response.json({error:'Invalid environment copy request'},{status:400});
    const response=await this.serialized(async()=>{
      const rows=await this.environmentRows(tenantId),source=rows.find(row=>row.id===sourceId);
      if(!source) return Response.json({error:'Environment not found'},{status:404});
      if(source.kind==='local')return Response.json({error:'本地环境请在本机复制'},{status:409});
      if(source.status && source.status!=='ready') return Response.json({error:'Wait until the source environment is ready'},{status:409});
      const existing=rows.find(row=>row.id===parsed.data.requestId);
      if(existing) {
        if(existing.copy?.requestId!==parsed.data.requestId || existing.copy.sourceId!==sourceId || existing.name!==parsed.data.name) return Response.json({error:'Copy request identity was reused'},{status:409});
        if(existing.status==='deleted'||existing.status==='deleting')return Response.json({error:'Environment was deleted'},{status:410});
        if(existing.copy.phase==='done') return Response.json(existing);
        if(existing.lifecycle&&existing.lifecycle.phase!=='done')return Response.json({error:'Environment lifecycle operation is in progress'},{status:409});
        existing.status='copying';delete existing.copy.error;
        this.ctx.storage.sql.exec('INSERT INTO weft_environment_copy_jobs VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET document=excluded.document',existing.id,JSON.stringify({tenantId,record:existing}));
        await this.env.CONFIG_DB.prepare('UPDATE environments SET document=? WHERE tenant_id=? AND environment_id=?').bind(JSON.stringify(existing),tenantId,existing.id).run();
        this.registry=Promise.resolve(rows.map(row=>row.id===existing.id?existing:row));
        return Response.json(existing,{status:202});
      }
      if(rows.filter(row=>row.status!=='deleted').length>=64) return Response.json({error:'Environment limit reached'},{status:409});
      const now=new Date().toISOString();
      const record:EnvironmentRecord={id:parsed.data.requestId,name:parsed.data.name,createdAt:now,updatedAt:now,status:'copying',copy:{sourceId,requestId:parsed.data.requestId,phase:'snapshot',completed:0,total:0}};
      // Journal the reservation first. Recovery can repair a missing D1 row after a crash.
      await this.ctx.storage.setAlarm(Date.now()+30_000);
      this.ctx.storage.sql.exec('INSERT INTO weft_environment_copy_jobs VALUES (?,?,0)',record.id,JSON.stringify({tenantId,record}));
      await this.env.CONFIG_DB.prepare('INSERT INTO environments (tenant_id,environment_id,document) VALUES (?,?,?)').bind(tenantId,record.id,JSON.stringify(record)).run();
      this.registry=Promise.resolve([...rows,record].sort((a,b)=>a.id.localeCompare(b.id)));
      return Response.json(record,{status:202});
    });
    if(response.ok) {await this.ctx.storage.setAlarm(Date.now()+30_000);this.launchCopies();}
    return response;
  }
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
      for(const row of this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_copy_jobs').toArray()) {
        const job=JSON.parse(row.document) as {tenantId:string;record:EnvironmentRecord};
        if(job.tenantId===tenantId) await db.prepare('INSERT INTO environments (tenant_id,environment_id,document) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(tenantId,job.record.id,JSON.stringify(job.record)).run();
      }
      for(const row of this.ctx.storage.sql.exec<{document:string}>('SELECT document FROM weft_environment_lifecycle_jobs').toArray()){
        const job=JSON.parse(row.document) as EnvironmentLifecycleJob;
        if(job.tenantId===tenantId)await db.prepare('INSERT INTO environments (tenant_id,environment_id,document) VALUES (?,?,?) ON CONFLICT(tenant_id,environment_id) DO UPDATE SET document=excluded.document').bind(tenantId,job.record.id,JSON.stringify(job.record)).run();
      }
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
    return (await this.environmentRows(tenantId)).filter(row=>row.status!=='deleted').map(row=>this.localRecord(row));
  }
  async environment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | undefined> {
    this.scope(tenantId);
    id.parse(environmentId);
    const row=(await this.environmentRows(tenantId)).find((row) => row.id === environmentId);return row?this.localRecord(row):undefined;
  }
  async createEnvironment(tenantId: string, input: unknown): Promise<Response> {
    this.scope(tenantId);
    const parsed = environmentCreateSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid environment" }, { status: 400 });
    return this.serialized(async () => {
      const rows = await this.environmentRows(tenantId);
      const environmentId = parsed.data.id ?? crypto.randomUUID();
      if (rows.some((row) => row.id === environmentId) || this.ctx.storage.sql.exec('SELECT id FROM weft_environment_copy_jobs WHERE id=?',environmentId).toArray().length)
        return Response.json({ error: "Environment already exists" }, { status: 409 });
      if (rows.filter(row=>row.status!=='deleted').length >= 64)
        return Response.json({ error: "Environment limit reached" }, { status: 409 });
      if (parsed.data.configuration !== undefined) {
        if(parsed.data.kind==='local')return Response.json({error:'本地配置由本地 DSH 管理'},{status:400});
        const scope = {tenantId, environmentId};
        const initialized = await this.env.ENVIRONMENTS.getByName(environmentAddress(scope)).nativeInitializeEnvironment(scope, parsed.data.configuration);
        if (!initialized.ok) return initialized;
      }
      const now = new Date().toISOString();
      const record: EnvironmentRecord = {id: environmentId, name: parsed.data.name, createdAt: now, updatedAt: now,...(parsed.data.kind==='local'?{kind:'local' as const}:{})};
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
  private localRecord(row:EnvironmentRecord):EnvironmentRecord {
    if(row.kind!=='local')return row;
    return {...row,local:{online:Boolean(this.localRelay.host(row.id)),paired:Boolean(this.ctx.storage.sql.exec('SELECT id FROM weft_local_hosts WHERE id=? AND token_hash IS NOT NULL',row.id).toArray().length)}};
  }
  async localPairing(tenantId:string,environmentId:string,revoke=false):Promise<Response> {
    this.scope(tenantId);id.parse(environmentId);
    return this.serialized(async()=>{
      const row=await this.environment(tenantId,environmentId);
      if(row?.kind!=='local'||row.status==='deleted')return new Response('Local environment not found',{status:404});
      this.localRelay.disconnect(environmentId);
      if(revoke){this.ctx.storage.sql.exec('DELETE FROM weft_local_hosts WHERE id=?',environmentId);return Response.json({revoked:true});}
      const key=newKey(),digest=await hashKey(key),expires=Date.now()+10*60_000;
      this.ctx.storage.sql.exec('INSERT INTO weft_local_hosts VALUES (?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET pair_hash=excluded.pair_hash,pair_expires=excluded.pair_expires,token_hash=NULL',environmentId,digest,expires);
      return Response.json({pairingKey:key,expiresAt:expires,protocol:LOCAL_PROTOCOL},{headers:{'cache-control':'private, no-store'}});
    });
  }
  /** Device carrier authenticates independently of browser Access; only these two routes are public at the edge. */
  async localDevice(tenantId:string,environmentId:string,request:Request):Promise<Response> {
    this.scope(tenantId);id.parse(environmentId);
    if(request.headers.has('origin'))return new Response('Device endpoint',{status:403});
    const key=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!key)return new Response('Unauthorized',{status:401});
    const digest=await hashKey(key);
    if(new URL(request.url).pathname.endsWith('/pair')&&request.method==='POST')return this.serialized(async()=>{
      const row=await this.environment(tenantId,environmentId);
      const stored=this.ctx.storage.sql.exec<{pair_hash:string|null;pair_expires:number|null}>('SELECT pair_hash,pair_expires FROM weft_local_hosts WHERE id=?',environmentId).toArray()[0];
      if(row?.kind!=='local'||row.status==='deleted'||stored?.pair_hash!==digest||(stored.pair_expires??0)<Date.now())return new Response('Invalid or expired pairing key',{status:401});
      const token=newKey(),tokenHash=await hashKey(token);
      this.ctx.storage.sql.exec('UPDATE weft_local_hosts SET token_hash=?,pair_hash=NULL,pair_expires=NULL WHERE id=?',tokenHash,environmentId);
      return Response.json({token,protocol:LOCAL_PROTOCOL},{headers:{'cache-control':'no-store'}});
    });
    if(!new URL(request.url).pathname.endsWith('/connect')||request.method!=='GET'||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('Not found',{status:404});
    // Serialize with revocation: an in-flight handshake cannot survive a revoke.
    return this.serialized(async()=>{
      const row=await this.environment(tenantId,environmentId);
      const stored=this.ctx.storage.sql.exec<{token_hash:string|null}>('SELECT token_hash FROM weft_local_hosts WHERE id=?',environmentId).toArray()[0];
      if(row?.kind!=='local'||row.status==='deleted'||stored?.token_hash!==digest)return new Response('Unauthorized',{status:401});
      const protocol=request.headers.get('x-weft-protocol');
      if(!supportsLocalProtocol(protocol)||!supportsDshVersion(request.headers.get('x-dsh-version')))return new Response(`Incompatible local Host version; supported DSH: ${SUPPORTED_DSH_VERSIONS.join(', ')}`,{status:409});
      return this.localRelay.acceptHost(environmentId,protocol!);
    });
  }
  async localProxy(tenantId:string,environmentId:string,request:Request,path:string):Promise<Response> {
    this.scope(tenantId);id.parse(environmentId);
    const row=await this.environment(tenantId,environmentId);
    if(row?.kind!=='local'||row.status==='deleted')return new Response('Not found',{status:404});
    return this.localRelay.proxy(environmentId,request,path);
  }
  /** Use Fetch for upgrades: native WebSocket responses retain their carrier. */
  override async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    const device=/^\/v1\/local-hosts\/([a-zA-Z0-9_-]{1,80})\/([a-zA-Z0-9_-]{1,80})\/(pair|connect)$/.exec(url.pathname);
    if(device)return this.localDevice(device[1]!,device[2]!,request);
    const browser=/^\/v1\/tenants\/([a-zA-Z0-9_-]{1,80})\/environments\/([a-zA-Z0-9_-]{1,80})\/local\/web(\/.*)$/.exec(url.pathname);
    if(browser)return this.localProxy(browser[1]!,browser[2]!,request,browser[3]!+url.search);
    return new Response('Not found',{status:404});
  }
  override webSocketMessage(socket:WebSocket,message:string|ArrayBuffer):void {this.localRelay.message(socket,message);}
  override webSocketClose(socket:WebSocket):void {this.localRelay.closed(socket);}
  override webSocketError(socket:WebSocket):void {this.localRelay.closed(socket);}
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
guardLifecycle(EnvironmentDO);
