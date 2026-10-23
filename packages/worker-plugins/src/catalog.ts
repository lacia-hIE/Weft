import z from '@deepseek-ai/schemastery';
import {applyEntryPatches, type PatchOptions} from '@deepseek-ai/cordis-plugin-include';
import type {BundleInfo, PluginInfo, PluginEntryId} from '@deepseek-ai/dsh-plugin-manager/types';
import javascript from '../javascript/package.json';
import javascriptPatch from '../javascript/cordis.patch.json';
import documents from '../documents/package.json';
import documentsPatch from '../documents/cordis.patch.json';
import management from '../management/package.json';
import managementPatch from '../management/cordis.patch.json';

export const JS = 'weft-javascript', DOCS = 'weft-documents', CARDS = 'weft-task-cards';
export const BUNDLES = 'weft-worker-bundles';
export const JavaScriptConfig = z.object({
  enabled: z.boolean().default(true).volatile().description('Offer javascript_task to Agents. Existing tasks remain manageable from Worker tasks.'),
  defaultTimeoutMs: z.natural().min(1).max(600000).default(120000).volatile().description('Default execution timeout in milliseconds; the platform maximum is 600000.'),
  allowWritable: z.boolean().default(true).volatile().description('Allow new writable tasks within the Session sandbox. Disabling this does not cancel existing tasks.'),
});
export const DocumentsConfig = z.object({
  enabled: z.boolean().default(true).volatile().description('Offer document_to_markdown to Agents.'),
  maxInputMiB: z.natural().min(1).max(10).default(10).volatile().description('Maximum input size in MiB, up to the platform limit of 10.'),
  previewCharacters: z.natural().min(1).max(20000).default(20000).volatile().description('Characters returned to the Agent; a saved Markdown file retains the full result.'),
});
export const CardsConfig = z.object({enabled: z.boolean().default(true).volatile().description('Show JavaScript tool cards. Worker tasks in the Session header remains available for existing tasks.')});
export const BundlesConfig = z.object({javascript: z.boolean().default(true).volatile(), documents: z.boolean().default(true).volatile()});
export interface WorkerPluginSettings {
  bundles: {javascript: boolean; documents: boolean};
  javascript: {enabled: boolean; defaultTimeoutMs: number; allowWritable: boolean};
  documents: {enabled: boolean; maxInputMiB: number; previewCharacters: number};
  cards: {enabled: boolean};
}
export const workerNamespaces = [
  {id: JS, schema: JavaScriptConfig}, {id: DOCS, schema: DocumentsConfig}, {id: CARDS, schema: CardsConfig},
  {id: BUNDLES, schema: BundlesConfig, hidden: true as const},
];
export const workerBundles = [
  {manifest: javascript, patch: javascriptPatch, key: 'javascript' as const, title: {zh: 'Worker JavaScript', en: 'Worker JavaScript'}},
  {manifest: documents, patch: documentsPatch, key: 'documents' as const, title: {zh: '文档转 Markdown', en: 'Documents to Markdown'}},
];
export const managementRows = applyEntryPatches([], managementPatch as PatchOptions[], message => {throw new Error(message);});
export function workerRows(settings: WorkerPluginSettings) {
  return workerBundles.flatMap(bundle => applyEntryPatches([], bundle.patch as PatchOptions[], message => {throw new Error(message);}).map(row => ({
    ...row, disabled: !settings.bundles[bundle.key] || !(row.id === JS ? settings.javascript.enabled : row.id === DOCS ? settings.documents.enabled : settings.cards.enabled),
  })));
}
export function workerBundleInfo(settings: WorkerPluginSettings): BundleInfo[] {
  const optional: BundleInfo[] = workerBundles.map(({manifest, patch, key, title}) => ({
    name: manifest.name, version: manifest.version, description: manifest.description, meta: {title}, official: false,
    availability: 'installation', installed: true, enabled: settings.bundles[key], optional: true, removable: false,
    rows: patch.flatMap(layer => layer.insert.map(row => ({rowId: row.id, moduleName: row.name, entryId: row.id as PluginEntryId}))), overrides: [],
  }));
  return [...optional, {name: management.name, version: management.version, description: management.description,
    meta: {title: {en: 'Worker task management', zh: 'Worker 任务管理'}}, official: false, availability: 'installation', installed: true, enabled: true,
    optional: false, removable: false, readOnlyReason: 'management-required',
    rows: managementRows.map(row => ({rowId: row.id!, moduleName: row.name!, entryId: row.id as PluginEntryId})), overrides: []}];
}
export function workerPluginInfo(settings: WorkerPluginSettings): PluginInfo[] {
  const optional: PluginInfo[] = workerRows(settings).map(row => ({entryId: row.id as PluginEntryId, patchId: row.id!, moduleName: row.name!, enabled: !row.disabled, fiberPhase: null,
    meta: {title: {en: row.id === JS ? 'JavaScript tasks' : row.id === DOCS ? 'Documents to Markdown' : 'Worker task cards', zh: row.id === JS ? 'JavaScript 任务' : row.id === DOCS ? '文档转 Markdown' : 'Worker 任务卡片'}, description: {
      en: 'Weft plugin. Changes apply before the next turn. Existing tasks remain accessible in Worker tasks. Browser cards update live.',
      zh: 'Weft 插件。工具开关在下一轮前生效；已有任务仍可在 Worker 任务中管理。浏览器卡片实时更新。',
    }}}));
  return [...optional, ...managementRows.map(row => ({entryId: row.id as PluginEntryId, moduleName: row.name!, enabled: true, fiberPhase: null, readOnlyReason: 'management-required' as const,
    meta: {description: {en: 'Platform plugin for viewing/cancelling existing tasks and enforcing sandbox changes.', zh: '平台插件：管理已有任务并落实会话沙箱权限变更。'}}}))];
}
