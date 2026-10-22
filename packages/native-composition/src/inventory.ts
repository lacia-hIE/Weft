import type {Context} from '@deepseek-ai/cordis';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import {pluginEntryId, type PluginInventoryEntry} from '@deepseek-ai/dsh-host-plugin-inventory';
import type {BundleInfo, PluginInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import {officialProfile, walkEntries} from '../../harness-profile/src/official.ts';
import {EXTERNAL, LOADED, MOUNTED_BY_WEFT, NOT_APPLICABLE, PENDING, PLATFORM, PRESET_ROWS, isBrowserRow} from '../../harness-profile/src/overlay.ts';
import {isManageableProfileRow, type ProfileEnablement} from '../../harness-profile/src/management.ts';
import bundles from '../../../.generated/official-bundles.json';
import bootReport from '../../../.generated/official-web-boot-report.json';
import baseManifest from '@weft/upstream/packages/bundle/base/package.json';
import webManifest from '@weft/upstream/packages/bundle/web-app/package.json';

interface Integration {enabled: boolean; en: string; zh: string}
const browserModules = new Set((bootReport as {modules?: string[]}).modules ?? []);
export const officialPluginIds = new Set<string>();
walkEntries(officialProfile, entry => {if (!entry.group) officialPluginIds.add(entry.id);});
export const officialBundleNames: readonly string[] = [baseManifest.name, webManifest.name];

/** Deployment wiring, never a claim about fibers in another Session or browser. */
function integration(entry: EntryOptions, enablement: ProfileEnablement): Integration {
  const id = entry.id;
  if (isBrowserRow(entry.name)) {
    const enabled = browserModules.has(entry.name);
    return {enabled, en: enabled ? 'Browser plugin; loaded by the page Boot Graph.' : 'Browser plugin; unavailable in this Web deployment.', zh: enabled ? '浏览器插件：由页面加载。' : '浏览器插件：当前 Web 环境不提供此能力。'};
  }
  if (PRESET_ROWS.has(id)) return {enabled: false, en: 'Provided by Agent presets; disabled at the global level.', zh: '由 Agent 预设按会话提供，全局层停用。'};
  if (Object.hasOwn(LOADED, id)) {
    const enabled = enablement[id] !== false;
    const optional = isManageableProfileRow(id);
    return {enabled,
      en: `${enabled ? 'Enabled' : 'Disabled'} for Session loading.${optional ? ' Changes apply before the next turn; active turns finish unchanged.' : ' Required profile service; enablement is managed by the deployment.'} Live Session state is not observed here.`,
      zh: `会话加载配置：${enabled ? '已启用' : '已停用'}。${optional ? '开关在下一轮运行前生效，正在运行的轮次保持原配置。' : '基础服务，启停由部署管理。'}此处不表示会话实时运行状态。`};
  }
  if (Object.hasOwn(MOUNTED_BY_WEFT, id)) return {enabled: true, en: `Mounted by Weft: ${MOUNTED_BY_WEFT[id]}. Activation depends on the owning world; live state is not observed here.`, zh: `由 Weft 装配：${MOUNTED_BY_WEFT[id]}。随所属环境或会话启用，此处不表示实时运行状态。`};
  if (Object.hasOwn(PLATFORM, id)) return {enabled: true, en: `Platform replacement: ${PLATFORM[id]}. Managed by the deployment.`, zh: `平台替代：${PLATFORM[id]}。由部署管理。`};
  if (Object.hasOwn(EXTERNAL, id)) return {enabled: false, en: `Not connected; requires ${EXTERNAL[id]}.`, zh: `尚未接入，需要：${EXTERNAL[id]}。`};
  if (Object.hasOwn(PENDING, id)) return {enabled: false, en: `Not implemented; requires ${PENDING[id]}.`, zh: `尚未实现，需要：${PENDING[id]}。`};
  if (Object.hasOwn(NOT_APPLICABLE, id)) return {enabled: false, en: `Not applicable to this deployment: ${NOT_APPLICABLE[id]}.`, zh: `当前部署不适用：${NOT_APPLICABLE[id]}。`};
  throw new Error('Unclassified official plugin entry: '+id);
}

/** Keep upstream metadata and add wiring details using the existing localized description ABI. */
export function officialInventory(ctx: Context, enablement: ProfileEnablement): PluginInventoryEntry[] {
  const entries: PluginInventoryEntry[] = [];
  walkEntries(officialProfile, entry => {
    if (entry.group) return;
    const state = integration(entry, enablement);
    const meta = ctx.pluginPackages.metaOf(entry.name, ctx.baseUrl ?? 'https://weft.invalid/prebuilt/');
    const text = (locale: string) => typeof meta?.description === 'string' ? meta.description : meta?.description?.[locale] ?? meta?.description?.en ?? '';
    entries.push({entryId: pluginEntryId(entry.id), moduleName: entry.name, enabled: state.enabled, fiberPhase: null,
      meta: {...meta, description: {en: [state.en, text('en')].filter(Boolean).join('\n'), zh: [state.zh, text('zh')].filter(Boolean).join('\n')}}});
  });
  return entries;
}

export function officialPluginInfo(entry: PluginInventoryEntry): PluginInfo {
  return isManageableProfileRow(entry.entryId) ? {...entry, patchId: entry.entryId} : {...entry, readOnlyReason: 'management-required'};
}

/** Bundle provenance is the layer that declares a row, rather than a later config override. */
export function officialBundles(entries: readonly PluginInventoryEntry[]): BundleInfo[] {
  const declared = (patches: readonly unknown[]): Set<string> => {
    const ids = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {for (const child of value) visit(child); return;}
      if (!value || typeof value !== 'object') return;
      const row = value as {id?: string; name?: string; insert?: unknown; config?: unknown; group?: boolean};
      if (row.id && row.name && !row.group) ids.add(row.id);
      if (row.insert) visit(row.insert);
      if (row.group) visit(row.config);
    };
    visit(patches);
    return ids;
  };
  const web = declared(bundles['web-app']);
  return [baseManifest, webManifest].map((manifest, index): BundleInfo => ({
    name: manifest.name, version: manifest.version, description: manifest.description,
    meta: {title: {en: index ? 'Web plugins' : 'Core plugins', zh: index ? 'Web 插件' : '基础插件'}},
    availability: 'installation', official: true, installed: true, enabled: true, optional: false, removable: false, readOnlyReason: 'management-required',
    rows: entries.filter(entry => web.has(entry.entryId) === Boolean(index)).map(entry => ({rowId: entry.entryId, moduleName: entry.moduleName, entryId: entry.entryId, ...(entry.meta ? {meta: entry.meta} : {})})), overrides: [],
  }));
}
