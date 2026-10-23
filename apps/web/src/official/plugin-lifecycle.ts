import type {PluginInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {PluginCoordinator} from '../../../../packages/plugin-registry/src/lifecycle.ts';
import type {PluginPlanEntry} from '../../../../packages/plugin-registry/src/types.ts';
import {environmentClientModules} from './plugin-modules.ts';

interface Fiber {dispose(): Promise<void>; update(config: unknown, force?: boolean): void; await(): Promise<void>}
interface ClientContext {
  plugin(plugin: object, config?: unknown): Fiber;
  remote: {
    pluginManager: {listPlugins(): Promise<{ok: boolean; value?: PluginInfo[]}>};
    settings: {describe(): Promise<{ok: boolean; value?: SettingsDescribeValue}>};
    $on(event: string, listener: () => void): unknown;
  };
  on(event: string, listener: () => void): unknown;
  effect(callback: () => () => unknown, label: string): unknown;
}
export const name = 'weft-environment-plugin-lifecycle';
export const inject = ['remote', 'remote.pluginManager', 'remote.settings'];

/** Original manager/settings RPCs feed the same coordinator as Host Loader entries. */
export function apply(ctx: ClientContext) {
  const fibers = new Map<string, Fiber>();
  const coordinator = new PluginCoordinator({
    apply: async entry => {
      const fiber = fibers.get(entry.id);
      if (entry.disabled) {if (fiber) {await fiber.dispose(); fibers.delete(entry.id);} return;}
      if (fiber) {fiber.update(entry.config, true); await fiber.await(); return;}
      const plugin = environmentClientModules[entry.name];
      if (!plugin) throw new Error('Unregistered client plugin: '+entry.name);
      const next = ctx.plugin(plugin, entry.config);
      try {await next.await(); fibers.set(entry.id, next);}
      catch (error) {await next.dispose(); throw error;}
    },
    remove: async entry => {const fiber = fibers.get(entry.id); if (fiber) {await fiber.dispose(); fibers.delete(entry.id);}},
  });
  let closed = false, dirty = false, revision = 0;
  let work: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (closed) return;
    dirty = true; revision++; clearTimeout(retry);
    if (work) return;
    work = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const current = revision;
        const [plugins, settings] = await Promise.all([ctx.remote.pluginManager.listPlugins(), ctx.remote.settings.describe()]);
        if (!plugins.ok || !plugins.value || !settings.ok || !settings.value) throw new Error('Unable to read native plugin composition');
        if (closed || current !== revision) continue;
        const configs = new Map(settings.value.namespaces.map(row => [row.ns, row.value]));
        const entries: PluginPlanEntry[] = plugins.value.filter(plugin => Object.hasOwn(environmentClientModules, plugin.moduleName)).map(plugin => ({
          id: plugin.entryId, name: plugin.moduleName, target: 'client', disabled: !plugin.enabled,
          config: (configs.get(plugin.entryId) ?? {}) as Record<string, unknown>,
        }));
        await coordinator.reconcile({entries});
      }
    })().catch(error => {
      if (!closed) {console.error('[weft] native client plugin reconciliation failed', error); retry = setTimeout(refresh, 15000);}
    }).finally(() => {work = undefined; if (dirty && !closed) refresh();});
  };
  ctx.remote.$on('plugin-manager/changed', refresh);
  ctx.remote.$on('settings/document-updated', refresh);
  ctx.on('connection/reset', refresh);
  ctx.effect(() => () => {closed = true; clearTimeout(retry); return coordinator.dispose();}, 'weft.client-plugin-lifecycle');
  refresh();
}
