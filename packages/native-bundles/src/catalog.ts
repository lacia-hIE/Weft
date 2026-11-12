import type {PatchOptions} from '@deepseek-ai/cordis-plugin-include';
import type {AgentRevision} from '../../control-plane/src/contracts.ts';
import type {BundleInfo, PluginInfo, PluginEntryId} from '@deepseek-ai/dsh-plugin-manager/types';
import type {PluginLocalizedMeta} from '@deepseek-ai/dsh-package-manifest';
import definitions from '../../../.generated/official-optional-bundles.json';
import metadata from '../../../.generated/plugin-meta.json';

/**
 * Official bundles that no longer exist upstream. DSH 0.2.2-rc.2 folded Agent
 * Teams into the base and Web bundles, so its former optional selection is
 * removed when the environment's registry opens, as the original profile
 * loader does.
 */
export const RETIRED_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-experimental-agent-team-profile'];
export const optionalBundles: ReadonlyArray<{name: string; version: string; description: string; upstream: string; digest: string; patch: PatchOptions[]}> = definitions as never;
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

/**
 * An optional official bundle applies only through a reviewed runtime adapter.
 * None ships with this deployment's upstream, so a profile is returned as
 * published and an enabled selection is refused rather than silently ignored.
 */
export function composeBundleProfile(profile: AgentRevision, states: readonly BundleState[]): AgentRevision {
  for (const state of states.filter(row => row.enabled)) {
    const bundle = shippedBundle(state.name);
    if (!bundle || bundle.version !== state.version || bundle.digest !== state.digest) throw new Error('Official bundle version unavailable; reinstall the deployment version');
    throw new Error('Official bundle has no runtime adapter');
  }
  return profile;
}

export function optionalBundleInfo(states: readonly BundleState[]): BundleInfo[] {
  return optionalBundles.map(bundle => {
    const state = states.find(row => row.name === bundle.name);
    const compatible = !state || availableBundleStates([state]).length === 1;
    const inserts = bundle.patch.flatMap(row => 'insert' in row && Array.isArray(row.insert) ? row.insert as {id: string; name: string}[] : []);
    return {name: bundle.name, version: state?.version ?? bundle.version, description: bundle.description,
      ...(metaOf(bundle.name) ? {meta: metaOf(bundle.name)!} : {}), official: true,
      availability: state ? 'profile' : 'missing', installed: Boolean(state), enabled: compatible && (state?.enabled ?? false),
      installTarget: {spec: `${bundle.name}@${bundle.version}`, version: bundle.version}, optional: false, removable: Boolean(state),
      rows: inserts.map(row => ({rowId: row.id, moduleName: row.name,
        ...(metaOf(row.name) ? {meta: metaOf(row.name)!} : {}),
        ...(state ? {entryId: entryId(bundle.name, row.id)} : {})})),
      overrides: bundle.patch.flatMap(row => 'id' in row && typeof row.id === 'string' ? [row.id] : []),
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
