import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import AgentPresets, {type PresetDefinition} from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import {profileEntry, presetEntryId} from '../../harness-profile/src/index.ts';
import {prebuiltPluginModules, type PluginSelection} from '../../plugin-runtime/src/catalog.ts';
const compositions = new WeakSet<Context>();

export async function replaceNativePreset(ctx: Context, definition: PresetDefinition): Promise<void> {
  if (!compositions.has(ctx)) throw new Error('Native composition is not mounted');
  const id = presetEntryId(definition.id);
  const existing = ctx.loader.store[id];
  if (existing) {await existing.fiber?.dispose(); ctx.loader.remove(id);}
  await ctx.loader.create(profileEntry(definition));
  await ctx.loader.resolve(id).fiber?.await();
}

/** Real Loader tree over modules included in this Worker, without disk imports. */
class WorkerdLoader extends Loader {
  override write(): void { /* The environment owns immutable profile snapshots. */ }
  override import(name: string): unknown {
    if (!name.startsWith('cordis:') || !Object.hasOwn(this.builtins, name.slice(7))) throw new Error('Plugin is not in the prebuilt workerd catalog: '+name);
    return this.builtins[name.slice(7)];
  }
}

/** Native preset generations and scope binding; no replacement Agent runtime. */
export async function mountNativeComposition(ctx: Context, definitions: readonly PresetDefinition[], defaultId: string, disabled: readonly string[] = []): Promise<AgentPresets> {
  await ctx.plugin(WorkerdLoader, {baseUrl: 'https://weft.invalid/prebuilt/'});
  Object.assign(ctx.loader.builtins, {group: Group, 'agent-preset': AgentPreset, ...prebuiltPluginModules});
  await ctx.plugin(AgentPresets, {default: defaultId});
  compositions.add(ctx);
  for (const definition of definitions) {
    await ctx.loader.create(profileEntry(definition, disabled.includes(definition.id)));
    await ctx.loader.resolve(presetEntryId(definition.id)).fiber?.await();
  }
  return ctx.agentPresets;
}

/** Official preset groups whose services the registry requires in private realms. */
const presetGroups = [
  {id: 'planning', members: ['plan-mode'], isolate: {planMode: true}},
  {id: 'compaction', members: ['compaction-basic', 'command-compact', 'tool-result-pruner'], isolate: {compaction: true, toolResultPruner: true}},
] as const;

export function nativePresetDefinition(profile: {spec: {id: string; name: string; plugins: PluginSelection[]; allowClientPlugins?: boolean}}): PresetDefinition {
  const row = (plugin: PluginSelection) => ({id: plugin.id, name: 'cordis:'+plugin.id, config: plugin.config, ...(plugin.id === 'tool-skill' ? {isolate: {skills: true as const}} : {})});
  const plugins: Array<PresetDefinition['plugins'][number]> = [];
  for (const plugin of profile.spec.plugins) {
    const group = presetGroups.find(item => (item.members as readonly string[]).includes(plugin.id));
    if (!group) {plugins.push(row(plugin)); continue;}
    if (plugins.some(entry => entry.id === group.id)) continue;
    const members = profile.spec.plugins.filter(item => (group.members as readonly string[]).includes(item.id));
    plugins.push({id: group.id, name: 'cordis:group', group: true, isolate: {...group.isolate}, config: members.map(row)});
  }
  return {id: profile.spec.id, name: profile.spec.name, description: profile.spec.allowClientPlugins ? 'Create UI and tool plugins through conversation.' : 'Work with files and configured tools.', plugins};
}
