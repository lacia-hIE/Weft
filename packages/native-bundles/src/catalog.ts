import {applyEntryPatches, type PatchOptions} from '@deepseek-ai/cordis-plugin-include';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import type {AgentRevision} from '../../control-plane/src/contracts.ts';
import type {BundleInfo, PluginInfo, PluginEntryId} from '@deepseek-ai/dsh-plugin-manager/types';
import type {PluginLocalizedMeta} from '@deepseek-ai/dsh-package-manifest';
import definitions from '../../../.generated/official-optional-bundles.json';
import metadata from '../../../.generated/plugin-meta.json';

export const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile';
export const TEAM_CLIENT = '@deepseek-ai/dsh-experimental-client-ui-agent-team';
export const optionalBundles = definitions;
export interface BundleState {name: string; version: string; digest: string; enabled: boolean}
const entryId = (name: string, id: string): PluginEntryId => `official-bundle:${name}:${id}` as PluginEntryId;
const metaOf = (name: string) => (metadata.packages as Record<string, PluginLocalizedMeta>)[name];

/** Exact shipped code only; a version or source outside this catalog cannot acquire trust. */
export function shippedBundle(spec: string) {
  return optionalBundles.find(row => spec === row.name || spec === `${row.name}@${row.version}`);
}
export function namesOfficialBundle(spec: string): boolean {
  return optionalBundles.some(row => spec === row.name || spec.startsWith(row.name+'@'));
}
export function availableBundleStates(states: readonly BundleState[]): BundleState[] {
  return states.filter(state => optionalBundles.some(bundle => bundle.name === state.name && bundle.version === state.version && bundle.digest === state.digest));
}

/** Apply the upstream patch, then separate root services and browser rows from preset tools. */
export function composeBundleProfile(profile: AgentRevision, states: readonly BundleState[]): AgentRevision {
  let rows: EntryOptions[] = profile.spec.plugins.map(row => ({id: row.id, config: structuredClone(row.config), name: 'cordis:'+row.id, ...(row.disabled === undefined ? {} : {disabled: row.disabled})}));
  for (const state of states.filter(row => row.enabled)) {
    const bundle = shippedBundle(state.name);
    if (!bundle || bundle.version !== state.version || bundle.digest !== state.digest) throw new Error('Official bundle version unavailable; reinstall the deployment version');
    if (bundle.name !== TEAM_BUNDLE) throw new Error('Official bundle has no runtime adapter');
    const patches = bundle.patch as PatchOptions[];
    // Minimal/custom presets need the original globally declared delegation
    // targets as disabled placeholders. The patch still runs unchanged.
    for (const patch of bundle.patch) {
      if ('id' in patch && !rows.some(row => row.id === patch.id)) rows.push({id: patch.id, name: 'cordis:'+patch.id, disabled: true});
    }
    rows = applyEntryPatches(rows, patches, (message, ...args) => {throw new Error(`Official bundle patch failed: ${message} ${args.join(' ')}`);});
  }
  return {...profile, spec: {...profile.spec, plugins: rows.map(row => {
    if (row.id === undefined || row.group || typeof row.disabled !== 'boolean' && row.disabled !== undefined) throw new Error('Unsupported official bundle row');
    return {id: row.id, config: (row.config ?? {}) as Record<string, unknown>, ...(row.disabled === undefined ? {} : {disabled: row.disabled})};
  })}};
}

export function optionalBundleInfo(states: readonly BundleState[]): BundleInfo[] {
  return optionalBundles.map(bundle => {
    const state = states.find(row => row.name === bundle.name);
    const compatible = !state || availableBundleStates([state]).length === 1;
    const inserts = bundle.patch.flatMap(row => 'insert' in row ? row.insert : []);
    return {name: bundle.name, version: state?.version ?? bundle.version, description: bundle.description,
      ...(metaOf(bundle.name) ? {meta: metaOf(bundle.name)!} : {}), official: true,
      availability: state ? 'profile' : 'missing', installed: Boolean(state), enabled: compatible && (state?.enabled ?? false),
      installTarget: {spec: `${bundle.name}@${bundle.version}`, version: bundle.version}, optional: false, removable: Boolean(state),
      rows: inserts.map(row => ({rowId: row.id, moduleName: row.name,
        ...(metaOf(row.name) ? {meta: metaOf(row.name)!} : {}),
        ...(state ? {entryId: entryId(bundle.name, row.id)} : {})})),
      overrides: bundle.patch.flatMap(row => 'id' in row ? [row.id] : []),
      ...(!compatible ? {error: {code: 'incompatible-version' as const, diagnostic: 'Reinstall the version included in this deployment.'}} : {}),
    };
  });
}

/** Declared environment wiring, not fabricated live Fiber observations. */
export function optionalBundlePlugins(states: readonly BundleState[]): PluginInfo[] {
  return optionalBundleInfo(states).filter(bundle => bundle.installed).flatMap(bundle => bundle.rows.map(row => ({
    entryId: entryId(bundle.name, row.rowId), moduleName: row.moduleName,
    enabled: bundle.enabled, fiberPhase: null, readOnlyReason: 'management-required' as const,
    meta: {...row.meta, description: {
      en: 'Controlled by the official bundle. Applies to new Sessions; refresh to update browser plugins. Live Session state is not observed here.',
      zh: '由官方组合包控制，应用于新会话；浏览器插件需刷新。此处不表示会话实时运行状态。',
    }},
  })));
}
