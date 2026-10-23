import type Schema from '@deepseek-ai/schemastery';
import type {PatchOptions} from '@deepseek-ai/cordis-plugin-include';
import type {PluginLocalizedMeta} from '@deepseek-ai/dsh-package-manifest';

export type ConfigSection = Record<string, unknown>;
export interface Enablement {namespace: string; key: string; defaultEnabled?: boolean}
export interface PluginRegistration {
  id: string;
  name: string;
  target: 'host' | 'client';
  Config?: Schema;
  enablement?: Enablement;
  meta?: PluginLocalizedMeta;
}
export interface BundleRegistration {
  manifest: {name: string; version: string; description?: string; dsh: {bundle: {patch: string}}};
  patch: readonly PatchOptions[];
  plugins: readonly PluginRegistration[];
  enablement?: Enablement;
  meta?: PluginLocalizedMeta;
}
/** Internal projection of native profile entries, not an installation format. */
export interface PluginPlanEntry {
  id: string; name: string; target: PluginRegistration['target']; disabled: boolean; config: ConfigSection;
}
export interface PluginPlan {entries: PluginPlanEntry[]}
export type ReadConfig = (namespace: string) => ConfigSection;
