import { Context, type Fiber } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import AgentPresets, {type PresetDefinition} from '@deepseek-ai/dsh-agent-preset-registry';
import {prebuiltPluginModules, type PluginSelection} from '../../plugin-runtime/src/catalog.ts';
const declarations = new WeakMap<Context, Map<string, Fiber>>();

export async function replaceNativePreset(ctx: Context, definition: PresetDefinition): Promise<void> {
  const mounted = declarations.get(ctx);
  if (!mounted) throw new Error('Native composition is not mounted');
  await mounted.get(definition.id)?.dispose();
  const fiber = ctx.plugin({name: 'weft-preset:'+definition.id, inject: ['agentPresets'], async* apply(child) {yield await child.agentPresets.register(definition);}});
  mounted.set(definition.id, fiber);
  await fiber.await();
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
export async function mountNativeComposition(ctx: Context, definitions: readonly PresetDefinition[], defaultId: string): Promise<AgentPresets> {
  await ctx.plugin(WorkerdLoader, {baseUrl: 'https://weft.invalid/prebuilt/'});
  Object.assign(ctx.loader.builtins, {group: Group, ...prebuiltPluginModules});
  await ctx.plugin(AgentPresets, {default: defaultId});
  declarations.set(ctx, new Map());
  for (const definition of definitions) await replaceNativePreset(ctx, definition);
  return ctx.agentPresets;
}

export function nativePresetDefinition(profile: {spec: {id: string; name: string; plugins: PluginSelection[]; allowClientPlugins?: boolean}}): PresetDefinition {
  return {id: profile.spec.id, name: profile.spec.name, description: profile.spec.allowClientPlugins ? 'Create UI and tool plugins through conversation.' : 'Work with files and configured tools.', plugins: profile.spec.plugins.map(plugin => ({id: plugin.id, name: 'cordis:'+plugin.id, config: plugin.config, ...(plugin.id === 'tool-skill' ? {isolate: {skills: true}} : {})}))};
}
