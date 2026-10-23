import {Context, Inject, type Plugin} from '@deepseek-ai/cordis';
import Loader, {Group, type EntryOptions} from '@deepseek-ai/cordis-plugin-loader';

/** Standard Cordis exports, including class plugins, retain their native Config/inject metadata. */
export function standardPlugin(namespace: unknown): Plugin {
  const module = namespace as {default?: unknown};
  const plugin = module.default ?? namespace;
  if (typeof plugin === 'function') {
    const meta = plugin as unknown as {inject?: object; Config?: unknown};
    return {name: plugin.name, ...(meta.inject === undefined ? {} : {inject: meta.inject}), ...(meta.Config === undefined ? {} : {Config: meta.Config}), apply: (ctx: Context, config: unknown) =>
      /^class\s/.test(Function.prototype.toString.call(plugin)) ? Reflect.construct(plugin, [ctx, config]) : Reflect.apply(plugin, undefined, [ctx, config])} as Plugin;
  }
  if (!plugin || typeof plugin !== 'object' || !('apply' in plugin) || typeof plugin.apply !== 'function') throw new Error('Bundle module must export a standard Cordis plugin');
  return plugin as Plugin;
}

/** Original Loader with a private service realm and an immutable, archive-locked module table. */
export function composeInstalledBundle(rows: Record<string, unknown>[], modules: Record<string, unknown>, decorate: (plugin: Plugin) => Plugin = plugin => plugin): Plugin {
  const plugins = Object.fromEntries(Object.entries(modules).map(([name, value]) => [name, standardPlugin(value)]));
  const inject = Object.assign({}, ...Object.values(plugins).map(plugin => Inject.resolve(plugin.inject)));
  return {name: 'installed-cordis-bundle', inject, async apply(ctx: Context) {
    class BundleLoader extends Loader {
      override write(): void {}
      override import(name: string): unknown {
        if (['group', 'cordis:group', '@deepseek-ai/cordis-plugin-group'].includes(name)) return Group;
        const plugin = plugins[name];
        if (!plugin) throw new Error('Bundle module is unavailable: '+name);
        return decorate(plugin);
      }
    }
    const privateContext = ctx.isolate('loader');
    const fiber = privateContext.plugin(BundleLoader, {baseUrl: 'https://installed.invalid/'});
    await fiber.await();
    const loader = privateContext.loader;
    for (const row of rows) await loader.create(structuredClone(row) as unknown as EntryOptions);
    const visit = async (entries: Iterable<ReturnType<typeof loader.resolve>>): Promise<void> => {
      for (const entry of entries) {
        await entry.fiber?.await();
        if (entry.options.disabled === true) continue;
        if (!entry.fiber || Object.keys(entry.fiber.inject).some(name => entry.ctx.get(name) === undefined)) throw new Error('Bundle entry has unavailable services: '+entry.options.id);
      }
    };
    await visit(loader.entries());
  }};
}
