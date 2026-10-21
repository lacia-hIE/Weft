import { Context } from '@deepseek-ai/cordis';
import {workerdLoader} from '../../native-profile/src/loader.ts';
import Group from '@deepseek-ai/cordis-plugin-group';
import AgentPresets, {type PresetDefinition} from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import {profileDefinitions, profileEntry, presetEntryId} from '../../harness-profile/src/index.ts';
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

/** Native preset generations and scope binding; no replacement Agent runtime. */
export async function mountNativeComposition(ctx: Context, definitions: readonly PresetDefinition[], defaultId: string, disabled: readonly string[] = []): Promise<AgentPresets> {
  await workerdLoader(ctx, {group: Group, 'agent-preset': AgentPreset, ...prebuiltPluginModules});
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
  // Weft's skill catalog service rides with the skill rows, private to the preset.
  {id: 'skills', members: ['skill-filesystem', 'tool-skill'], isolate: {skills: true}},
  {id: 'persistent-shell', members: ['pty', 'terminal-bash', 'persistent-bash'], isolate: {terminals: true}},
  {id: 'delegation', members: ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow'], isolate: {workflowEngine: true}},
] as const;

export function nativePresetDefinition(profile: {spec: {id: string; name: string; plugins: PluginSelection[]; allowClientPlugins?: boolean}}): PresetDefinition {
  const row = (plugin: PluginSelection) => ({id: plugin.id, name: 'cordis:'+plugin.id, config: plugin.config, ...(plugin.disabled ? {disabled: true} : {})});
  const plugins: Array<PresetDefinition['plugins'][number]> = [];
  for (const plugin of profile.spec.plugins) {
    const group = presetGroups.find(item => (item.members as readonly string[]).includes(plugin.id));
    if (!group) {plugins.push(row(plugin)); continue;}
    if (plugins.some(entry => entry.id === group.id)) continue;
    const members = profile.spec.plugins.filter(item => (group.members as readonly string[]).includes(item.id));
    plugins.push({id: group.id, name: 'cordis:group', group: true, isolate: {...group.isolate}, config: members.map(row)});
  }
  const order = profileDefinitions.find(definition => definition.id === profile.spec.id)?.order;
  return {id: profile.spec.id, ...presetDisplay(profile.spec.id, profile.spec.name), ...(order === undefined ? {} : {order}), plugins};
}

/** The official dictionaries' names of the built-in presets, for surfaces that show a preset as a plugin row. */
const OFFICIAL_PRESET_TITLES: Record<string, {en: string; zh: string}> = {standard: {en: 'Standard mode', zh: '标准模式'}, ptc: {en: 'PTC mode', zh: 'PTC 模式'}, minimal: {en: 'Minimal mode', zh: '极简模式'}, cordis: {en: 'Creator mode', zh: '创造模式'}};

/** A preset's title where it appears as a plugin row: localized for an unrenamed official preset. */
export function presetTitle(id: string, name: string): string | {en: string; zh: string} {
  const display = presetDisplay(id, name);
  return display.name ?? OFFICIAL_PRESET_TITLES[id] ?? id;
}

/** Official presets the client names from its own dictionaries while their name is unset. */
const OFFICIAL_PRESET_NAMES: Record<string, readonly string[]> = {standard: ['standard', 'Standard'], ptc: ['ptc'], minimal: ['minimal'], cordis: ['cordis', 'Creator']};
/** Weft's own presets: their shipped names, and the names environments seeded before them. */
const WEFT_PRESETS: Record<string, {name: string; description: string; seeded: readonly string[]}> = {
  default: {name: 'DeepSeek 助手', description: '使用工作区和已配置的工具完成任务。', seeded: ['DeepSeek Assistant']},
  delegator: {name: '委派模式', description: '把可以独立完成的子任务交给子 Agent 执行。', seeded: ['Delegator']},
};

/**
 * The registry's display fields for one preset. An official preset keeps its
 * name unset while the user has not renamed it, so the client shows the
 * localized official name and description; a renamed preset shows its name.
 */
export function presetDisplay(id: string, name: string): {name?: string; description?: string} {
  if (OFFICIAL_PRESET_NAMES[id]?.includes(name)) return {};
  const weft = WEFT_PRESETS[id];
  if (weft && (name === weft.name || weft.seeded.includes(name))) return {name: weft.name, description: weft.description};
  return {name};
}
