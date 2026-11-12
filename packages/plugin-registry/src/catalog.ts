import z from '@deepseek-ai/schemastery';
import {applyEntryPatches} from '@deepseek-ai/cordis-plugin-include';
import type {BundleInfo, PluginInfo, PluginEntryId, ChangeResult, PluginSpecInspection} from '@deepseek-ai/dsh-plugin-manager/types';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import type {BundleRegistration, Enablement, PluginRegistration, PluginPlan, ReadConfig, ConfigSection} from './types.ts';

/** Trusted modules declare once; configuration, inventory and controls use the same entries. */
export class PluginRegistry {
  readonly plugins: readonly PluginRegistration[];
  readonly namespaces: {id: string; schema: import('@deepseek-ai/schemastery').default; base: ConfigSection; hidden?: true}[];
  private readonly rows = new Map<string, EntryOptions>();
  constructor(readonly registrations: readonly BundleRegistration[]) {
    const ids = new Set<string>(), bundles = new Set<string>();
    this.plugins = registrations.flatMap(bundle => {
      if (bundles.has(bundle.manifest.name)) throw new Error('Duplicate bundle: '+bundle.manifest.name);
      bundles.add(bundle.manifest.name);
      const rows = applyEntryPatches([], bundle.patch as Parameters<typeof applyEntryPatches>[1], message => {throw new Error(message);});
      if (rows.length !== bundle.plugins.length) throw new Error('Bundle declarations do not match its native patch: '+bundle.manifest.name);
      for (const row of rows) {
        if (row.group || !bundle.plugins.some(plugin => plugin.id === row.id && plugin.name === row.name)) throw new Error('Unregistered native patch row: '+row.id);
        if (this.rows.has(row.id)) throw new Error('Duplicate native patch row: '+row.id);
        if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new Error('Prebuilt entry enablement must be a boolean');
        if (row.config !== undefined && (!row.config || typeof row.config !== 'object' || Array.isArray(row.config))) throw new Error('Prebuilt entry config must be a mapping');
        this.rows.set(row.id, row);
      }
      return bundle.plugins.map(plugin => {
        if (ids.has(plugin.id)) throw new Error('Duplicate plugin entry: '+plugin.id);
        ids.add(plugin.id); return plugin;
      });
    });
    const namespaces = new Map<string, {id: string; schema: import('@deepseek-ai/schemastery').default; base: ConfigSection; hidden?: true}>();
    for (const plugin of this.plugins) if (plugin.Config) namespaces.set(plugin.id, {id: plugin.id, schema: plugin.Config, base: structuredClone(this.rows.get(plugin.id)?.config ?? {})});
    const switches = new Map<string, Map<string, boolean>>();
    for (const control of [...registrations.map(bundle => bundle.enablement), ...this.plugins.map(plugin => plugin.enablement)]) {
      if (!control) continue;
      const namespace = namespaces.get(control.namespace);
      if (namespace) {
        if (namespace.schema.dict?.[control.key]?.type !== 'boolean') throw new Error('Enablement must reference a boolean config field');
        continue;
      }
      const keys = switches.get(control.namespace) ?? new Map();
      const value = control.defaultEnabled ?? true;
      if (keys.has(control.key) && keys.get(control.key) !== value) throw new Error('Conflicting enablement defaults');
      keys.set(control.key, value); switches.set(control.namespace, keys);
    }
    for (const [id, keys] of switches) namespaces.set(id, {id, schema: z.object(Object.fromEntries([...keys].map(([key, value]) => [key, z.boolean().default(value).volatile()]))), base: {}, hidden: true});
    this.namespaces = [...namespaces.values()];
  }
  private enabled(control: Enablement | undefined, read: ReadConfig): boolean {
    return !control || (read(control.namespace)[control.key] ?? control.defaultEnabled ?? true) === true;
  }
  hasNamespace(id: string) {return this.namespaces.some(row => row.id === id);}
  plan(read: ReadConfig): PluginPlan {
    return {entries: this.registrations.flatMap(bundle => bundle.plugins.map(plugin => ({id: plugin.id, name: plugin.name, target: plugin.target,
      disabled: this.rows.get(plugin.id)?.disabled === true || !this.enabled(bundle.enablement, read) || !this.enabled(plugin.enablement, read), config: plugin.Config ? structuredClone(read(plugin.id)) : structuredClone(this.rows.get(plugin.id)?.config ?? {}),
    })))};
  }
  bundles(read: ReadConfig): BundleInfo[] {
    return this.registrations.map(bundle => ({name: bundle.manifest.name, version: bundle.manifest.version,
      ...(bundle.manifest.description ? {description: bundle.manifest.description} : {}), ...(bundle.meta ? {meta: bundle.meta} : {}),
      official: false, availability: 'installation', installed: true, enabled: this.enabled(bundle.enablement, read), optional: Boolean(bundle.enablement), removable: false,
      ...(!bundle.enablement ? {readOnlyReason: 'management-required' as const} : {}),
      rows: bundle.plugins.map(plugin => ({rowId: plugin.id, moduleName: plugin.name, entryId: plugin.id as PluginEntryId, ...(plugin.meta ? {meta: plugin.meta} : {})})), overrides: [],
    }));
  }
  inventory(read: ReadConfig): PluginInfo[] {
    const plan = this.plan(read);
    return this.plugins.map(plugin => ({entryId: plugin.id as PluginEntryId, moduleName: plugin.name, enabled: !plan.entries.find(row => row.id === plugin.id)!.disabled,
      fiberPhase: null, ...(plugin.enablement ? {patchId: plugin.id} : {readOnlyReason: 'management-required' as const}), ...(plugin.meta ? {meta: plugin.meta} : {}),
    }));
  }
  inspect(spec: string): PluginSpecInspection | undefined {
    const bundle = this.registrations.find(row => spec === row.manifest.name || spec.startsWith(row.manifest.name+'@'));
    return bundle ? {status: 'refused', problem: 'already-installed', reason: 'This prebuilt bundle ships with the deployment. Use its plugin or bundle switches.'} : undefined;
  }
  async manage(endpoint: string, args: Record<string, unknown>, write: (control: Enablement, enabled: boolean) => Promise<boolean>): Promise<ChangeResult | undefined> {
    const target = String(args.id ?? args.name ?? args.spec ?? '');
    const bundle = this.registrations.find(row => row.manifest.name === args.name);
    const plugin = this.plugins.find(row => row.id === args.id);
    if (endpoint === 'pluginManager/installBundle' && this.inspect(String(args.spec))) return {changed: false, application: 'failed', stage: 'install', target, error: {code: 'already-installed'}};
    if (endpoint === 'pluginManager/removeBundle' && bundle) return {changed: false, application: 'failed', stage: 'remove', target, error: {code: bundle.enablement ? 'not-removable' : 'management-required'}};
    const selected = endpoint === 'pluginManager/setBundleEnabled' ? bundle : endpoint === 'pluginManager/setPluginEnabled' ? plugin : undefined;
    if (!selected) return undefined;
    if (!selected.enablement) return {changed: false, application: 'failed', stage: 'enable', target, error: {code: 'management-required'}};
    const enabled = args.enabled === true;
    return {changed: await write(selected.enablement, enabled), application: 'applied', stage: 'enable', target, enabled,
      warnings: ['Host plugins update before the next turn; browser plugins update live. Existing work remains manageable.']};
  }
  /** Whitelist native control writes before they reach the shared settings queue. */
  accepts(control: Enablement): boolean {
    return [...this.registrations, ...this.plugins].some(row => row.enablement?.namespace === control.namespace && row.enablement.key === control.key);
  }
}
