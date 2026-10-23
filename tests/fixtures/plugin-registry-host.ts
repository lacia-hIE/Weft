import {Context, type Plugin} from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import z from '@deepseek-ai/schemastery';
import {plainConfig} from '@weft/upstream/packages/settings/settings/src/schema.ts';
import {PluginRegistry} from '../../packages/plugin-registry/src/catalog.ts';
import {PluginCoordinator} from '../../packages/plugin-registry/src/lifecycle.ts';
import {loaderDriver} from '../../packages/plugin-registry/src/host.ts';

export async function boot() {
  const Config = z.object({enabled: z.boolean().default(true).volatile(), value: z.natural().default(1).volatile()});
  const counts = {active: 0, loads: 0, value: () => 0};
  const probe = {name: '@test/ordinary-plugin', Config, apply(ctx: Context, config: ReturnType<typeof Config>) {
    counts.loads++; counts.value = () => config.value.get();
    ctx.effect(() => {counts.active++; return () => {counts.active--;};}, 'probe');
  }};
  const registry = new PluginRegistry([{
    manifest: {name: '@test/bundle', version: '1.0.0', dsh: {bundle: {patch: './cordis.patch.json'}}},
    patch: [{insert: [{id: 'ordinary-plugin', name: probe.name, config: {value: 7}}]}],
    enablement: {namespace: 'test-bundles', key: 'probe', defaultEnabled: false},
    plugins: [{id: 'ordinary-plugin', name: probe.name, target: 'host', Config, enablement: {namespace: 'ordinary-plugin', key: 'enabled'}}],
  }]);
  const sections = new Map<string, Record<string, unknown>>();
  const read = (id: string) => {
    const ns = registry.namespaces.find(row => row.id === id)!;
    return plainConfig(ns.schema({...ns.base, ...sections.get(id)})) as Record<string, unknown>;
  };
  const modules: Record<string, Plugin> = {[probe.name]: probe};
  class MemoryLoader extends Loader {
    override write() {}
    override import(name: string) {const plugin = modules[name]; if (!plugin) throw new Error('Unknown module'); return plugin;}
  }
  const ctx = new Context();
  const fiber = ctx.plugin(MemoryLoader, {baseUrl: 'https://plugin-registry.test/'}); await fiber;
  const coordinator = new PluginCoordinator(loaderDriver(fiber.ctx.loader));
  return {registry, read, sections, counts, coordinator, ctx};
}
