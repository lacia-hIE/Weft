import {Context, Inject, isConstructor, symbols, type Plugin} from '@deepseek-ai/cordis';
import Loader, {Group, type EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import Schema from '@deepseek-ai/schemastery';

/** Standard Cordis exports, including class plugins, retain their native Config/inject metadata. */
export function standardPlugin(namespace: unknown): Plugin {
  const module = namespace as {default?: unknown};
  const plugin = module.default ?? namespace;
  if (typeof plugin === 'function') {
    const meta = plugin as unknown as {inject?: object; Config?: unknown};
    return {name: plugin.name, ...(meta.inject === undefined ? {} : {inject: meta.inject}), ...(meta.Config === undefined ? {} : {Config: meta.Config}), apply: (ctx: Context, config: unknown) => {
      if (!isConstructor(plugin)) return Reflect.apply(plugin, undefined, [ctx, config]);
      // Mirror Cordis Fiber's constructor lifecycle. The instance is not an
      // effect; only the native initialization hook may return a disposer.
      const instance = Reflect.construct(plugin, [ctx, config]);
      for (const hook of instance?.[symbols.initHooks] ?? []) hook();
      return instance?.[symbols.init]?.();
    }} as Plugin;
  }
  if (!plugin || typeof plugin !== 'object' || !('apply' in plugin) || typeof plugin.apply !== 'function') throw new Error('Bundle module must export a standard Cordis plugin');
  return plugin as Plugin;
}

/** The service a module's Cordis `Service` class or plugin object declares with a static `provide`. */
export function bundleService(namespace: unknown): string | undefined {
  const plugin = (namespace as {default?: unknown}).default ?? namespace;
  const provide = (plugin as {provide?: unknown} | null)?.provide;
  return typeof provide === 'string' && provide ? provide : undefined;
}

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Plain objects merge; arrays and scalar values replace, matching native profile layers. */
export function mergeConfig(base: Row, patch: Row): Row {
  const result = {...base};
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, {value: object(value) && object(base[key]) ? mergeConfig(base[key], value) : structuredClone(value), enumerable: true, writable: true, configurable: true});
  return result;
}
/** Leaf entries of a bundle, including those inside groups. */
export function bundleLeaves(rows: readonly Row[]): Row[] {
  return rows.flatMap(row => row.group ? bundleLeaves(Array.isArray(row.config) ? row.config as Row[] : []) : [row]);
}
/** The environment's configuration of an entry is a layer after the bundle's own patch. */
export function applyEntryConfig(rows: readonly Row[], overrides: Readonly<Record<string, Row>>): Row[] {
  return rows.map(row => row.group ? {...row, config: applyEntryConfig(Array.isArray(row.config) ? row.config as Row[] : [], overrides)}
    : typeof row.id === 'string' && Object.hasOwn(overrides, row.id) ? {...row, config: mergeConfig(object(row.config) ? row.config : {}, overrides[row.id]!)} : row);
}
export interface EntrySchema {id: string; schema: unknown}
/**
 * Serialized Config schemas of the bundle's entries. An entry is editable
 * only when its schema is an object that survives a JSON round trip and still
 * accepts the bundle's own configuration; functions and transforms do not.
 */
export function entrySchemas(rows: readonly Row[], modules: Record<string, unknown>): EntrySchema[] {
  return bundleLeaves(rows).flatMap(row => {
    const module = typeof row.name === 'string' ? modules[row.name] : undefined;
    if (typeof row.id !== 'string' || module === undefined) return [];
    try {
      const schema = (standardPlugin(module) as unknown as {Config?: Schema}).Config;
      if (!schema || typeof schema.toJSON !== 'function' || schema.type !== 'object') return [];
      const json: unknown = JSON.parse(JSON.stringify(schema.toJSON()));
      if (JSON.stringify(json).length > 65_536) return [];
      new Schema(json as never)(object(row.config) ? row.config : {});
      return [{id: row.id, schema: json}];
    } catch {return [];}
  });
}

/** Original Loader with a private service realm and an immutable, archive-locked module table. */
export function composeInstalledBundle(rows: Record<string, unknown>[], modules: Record<string, unknown>, decorate: (plugin: Plugin) => Plugin = plugin => plugin): Plugin {
  const plugins = Object.fromEntries(Object.entries(modules).map(([name, value]) => [name, standardPlugin(value)]));
  // A service one entry provides to its siblings is not a Host service.
  const local = new Set(Object.values(modules).flatMap(value => bundleService(value) ?? []));
  const inject = Object.fromEntries(Object.entries(Object.assign({}, ...Object.values(plugins).map(plugin => Inject.resolve(plugin.inject)))).filter(([name]) => !local.has(name)));
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
    // The service belongs to the Loader's own fiber. Its parent does not inject
    // this newly provided service and Cordis correctly rejects parent.loader.
    const loader = fiber.ctx.loader;
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
