import z from '@deepseek-ai/schemastery';
import type {BundleRegistration, PluginRegistration} from '../../plugin-registry/src/types.ts';
import {ID as JS, Config as JavaScriptConfig} from '../../native-computer/src/config.ts';
import {ID as DOCS, Config as DocumentsConfig} from '../../native-documents/src/config.ts';
import javascript from '../javascript/package.json';
import javascriptPatch from '../javascript/cordis.patch.json';
import documents from '../documents/package.json';
import documentsPatch from '../documents/cordis.patch.json';
import management from '../management/package.json';
import managementPatch from '../management/cordis.patch.json';

const BUNDLES = 'weft-worker-bundles';
const CardsConfig = z.object({enabled: z.boolean().default(true).volatile().description('Show JavaScript tool cards. Worker tasks in the Session header remains available for existing tasks.')});
const plugin = (id: string, name: string, target: PluginRegistration['target'], title: {en: string; zh: string}, Config?: PluginRegistration['Config']): PluginRegistration => ({
  id, name, target, ...(Config ? {Config, enablement: {namespace: id, key: 'enabled'}} : {}),
  meta: {title, description: Config ? {
    en: 'Weft plugin. Host changes apply before the next turn; browser changes apply live. Existing tasks remain manageable.',
    zh: 'Weft 插件。服务端配置在下一轮前生效，浏览器配置实时生效；已有任务仍可管理。',
  } : {en: 'Platform plugin for managing existing tasks and enforcing sandbox changes.', zh: '平台插件：管理已有任务并落实会话沙箱权限变更。'}},
});
/** Native patch declarations and their trusted module/configuration bindings. */
export const workerPluginBundles: readonly BundleRegistration[] = [
  {manifest: javascript, patch: javascriptPatch, enablement: {namespace: BUNDLES, key: 'javascript'}, meta: {title: {en: 'Worker JavaScript', zh: 'Worker JavaScript'}}, plugins: [
    plugin(JS, '@weft/worker-javascript-tool', 'host', {en: 'JavaScript tasks', zh: 'JavaScript 任务'}, JavaScriptConfig),
    plugin('weft-task-cards', '@weft/worker-task-cards', 'client', {en: 'Worker task cards', zh: 'Worker 任务卡片'}, CardsConfig),
  ]},
  {manifest: documents, patch: documentsPatch, enablement: {namespace: BUNDLES, key: 'documents'}, meta: {title: {en: 'Documents to Markdown', zh: '文档转 Markdown'}}, plugins: [
    plugin(DOCS, '@weft/worker-documents-tool', 'host', {en: 'Documents to Markdown', zh: '文档转 Markdown'}, DocumentsConfig),
  ]},
  {manifest: management, patch: managementPatch, meta: {title: {en: 'Worker task management', zh: 'Worker 任务管理'}}, plugins: [
    plugin('weft-task-sandbox', '@weft/worker-task-sandbox', 'host', {en: 'Task sandbox policy', zh: '任务沙箱策略'}),
    plugin('weft-task-management', '@weft/worker-task-management', 'client', {en: 'Worker task management', zh: 'Worker 任务管理'}),
  ]},
];
