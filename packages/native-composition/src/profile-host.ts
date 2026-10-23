import {Context} from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Commands from '@deepseek-ai/dsh-commands';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import Goals from '@deepseek-ai/dsh-goal';
import WebRuntime from '@deepseek-ai/dsh-web';
import {mountWorkspaceShell} from '../../workspace/src/subprocess.ts';
import SubagentModelSelection from '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
import remote from '../../../.generated/official-remotes/packages/preset/agent-preset-registry/typert.remote-client.js';
import {WorkerPtcRuntime} from '../../native-ptc/src/index.ts';
import {mountNativeComposition, nativePresetDefinition, presetTitle} from './index.ts';
import type {AgentRevision} from '../../control-plane/src/contracts.ts';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import {readPluginInventory} from '@deepseek-ai/dsh-host-plugin-inventory';
import {WorkerdPluginPackages} from './plugin-packages.ts';
import {profileManifest, profileDescriptor, profileEntries, presetEntryId} from '../../harness-profile/src/index.ts';
import type {PluginInfo, BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import pluginRemote from '../../../.generated/official-remotes/packages/boot/plugin-manager/typert.remote-client.js';
import inventoryRemote from '../../../.generated/official-remotes/packages/host/plugin-inventory/typert.remote-client.js';
import {mountOfficialTeam} from '../../native-bundles/src/runtime.ts';
import {SqliteSessionPersistence} from '../../session-persistence-do/src/index.ts';
import {mountNativeSubagentProviders} from '../../native-subagents/src/index.ts';
import {officialInventory, officialPluginInfo, officialBundles} from './inventory.ts';
import type {ProfileEnablement} from '../../harness-profile/src/management.ts';

export type CompositionEndpoint = 'agentPresets/list' | 'agentPresets/read' | 'pluginInventory/list' | 'pluginManager/listPlugins' | 'pluginManager/listBundles';
const methods = {...remote.methods, ...pluginRemote.methods, ...inventoryRemote.methods};

/** A real composition inspection world. It creates no Agent or session writer. */
export async function readNativePresets(profiles: AgentRevision[], defaultId: string, endpoint: CompositionEndpoint, raw: unknown, mountWorkspace: (ctx: Context) => Promise<void>, enablement: ProfileEnablement = {}, storage?: DurableObjectStorage): Promise<Response> {
  const method = methods[endpoint];
  const args = method.input({strict: true}).create().parse(raw);
  const ctx = new Context();
  try {
    await ctx.plugin(Llm);
    await ctx.plugin(WorkerdPluginPackages);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(Commands);
    await ctx.plugin(UserQuestions);
    await ctx.plugin(SubagentModelSelection);
    await ctx.plugin(SystemPrompt, {personaPrefix: ''});
    await ctx.plugin(Tools);
    await ctx.plugin(Agents);
    await ctx.plugin(Goals);
    await ctx.plugin(WebRuntime, {searchProvider: 'deepseek-official', fetchProvider: 'http'});
    await mountWorkspace(ctx);
    // Composition inspection never executes; the shell rows only need their services present.
    const inspectOnly = () => Promise.reject(new Error('Preset inspection does not execute commands'));
    await mountWorkspaceShell(ctx, {exec: inspectOnly, kill: inspectOnly}, '/workspace');
    await mountNativeSubagentProviders(ctx, {maxDepth: 1, maxActiveSubagents: 8});
    // This real persistence provider opens no handles in an inspection world;
    // no Agents, Sessions or writers are created here.
    if (storage) {await ctx.plugin(SqliteSessionPersistence, {storage}); await mountOfficialTeam(ctx, profiles);}
    // Without a loader the runtime is present for PTC and workflow rows but runs nothing.
    await ctx.plugin(WorkerPtcRuntime, {cwd: '/workspace'});
    const registry = await mountNativeComposition(ctx, profiles.map(nativePresetDefinition), defaultId, profiles.filter(profile => profile.spec.disabled).map(profile => profile.spec.id));
    let value: unknown;
    if (endpoint === 'agentPresets/list') value = await registry.remoteExportList();
    else if (endpoint === 'agentPresets/read') value = await registry.readDocument('agentPreset' in args && typeof args.agentPreset === 'string' ? args.agentPreset : '');
    else {
      const inventory = await readPluginInventory(ctx);
      const presets = inventory.entries.map(entry => {
        const owner = profiles.find(profile => presetEntryId(profile.spec.id) === entry.entryId);
        return {...entry, ...(owner ? {meta: {title: presetTitle(owner.spec.id, owner.spec.name)}} : {})};
      });
      const globals = officialInventory(ctx, enablement);
      const entries = [...globals, ...presets];
      if (endpoint === 'pluginInventory/list') value = {...inventory, entries, managementAvailable: true};
      else if (endpoint === 'pluginManager/listPlugins') value = [...globals.map(officialPluginInfo), ...presets.map((entry): PluginInfo => entry.entryId === presetEntryId(defaultId)
        ? {...entry, readOnlyReason: 'management-required'}
        : {...entry, patchId: entry.entryId})] satisfies PluginInfo[];
      else value = [...officialBundles(globals), {name: profileManifest.name, version: profileManifest.version, description: profileManifest.description,
        meta: {title: {en: 'Agent presets', zh: 'Agent 预设'}},
        availability: 'installation', official: false, installed: Object.hasOwn(profileDescriptor.dependencies, profileManifest.name), enabled: profileDescriptor.dsh.profile.bundles.includes(profileManifest.name), optional: false, removable: false, readOnlyReason: 'management-required',
        rows: profileEntries.map(entry => {
          const actual = entries.find(row => row.entryId === entry.id);
          return {rowId: entry.id, moduleName: entry.name, ...(actual ? {entryId: actual.entryId, ...(actual.meta ? {meta: actual.meta} : {})} : {})};
        }), overrides: [],
      }] satisfies BundleInfo[];
    }
    return Response.json({value: method.result.create().parse(value)});
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError('gateway/internal', 'Native preset inspection failed', {});
  } finally {await ctx.fiber.dispose();}
}
