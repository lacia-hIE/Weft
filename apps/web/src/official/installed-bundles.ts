import React from 'react';
import * as cordis from '@deepseek-ai/cordis';
import {composeInstalledBundle} from '../../../../packages/package-install/src/composition.ts';
import type {Installation, InstallJob, Artifact, Permissions} from '../../../../packages/package-install/src/contracts.ts';

interface Fiber {dispose(): Promise<void>; await(): Promise<unknown>}
interface ClientContext {
  slots: {inject(name: string, callback: () => unknown): unknown; register(spec: object, component: (props: {subject: {kind: string; pkg?: {name: string}}}) => React.ReactNode): unknown};
  locale: {register(ns: string, dictionaries: object): () => void; bind(ns: string): (key: string) => string};
  remote: {$on(name: string, callback: () => void): unknown};
  effect(callback: () => unknown, label: string): unknown;
  on(name: string, callback: () => void): unknown;
  plugin(plugin: object): Fiber;
  sidebarRight: {mounted: {getSnapshot(): string | undefined}};
}
const NS = 'weft.package-installations';
const zh = {title: '插件审核', summary: '审核原版 dsh.bundle.patch、构建产物和宿主能力。', spec: '插件包与精确版本', install: '安装并检查', refresh: '刷新', approve: '批准此版本并启用', review: '查看产物与权限', unavailable: '本部署未提供插件构建或存储服务。', loading: '正在读取安装记录…', empty: '尚未安装外部插件包。', trust: 'Client 模块会在工作台页面执行。批准前请确认来源、代码与所需权限。', nextTurn: 'Host 插件在下一轮运行前加载。', pending: '等待审批', enabled: '已启用', disabled: '已停用', code: '构建产物', files: '文件权限', tools: '注册工具', timer: '定时器', client: '浏览器模块', resolving: '解析依赖', building: '构建中', failed: '安装失败'};
const en: typeof zh = {title: 'Bundle review', summary: 'Review the original dsh.bundle.patch, compiled artifacts and Host capabilities.', spec: 'Package and exact version', install: 'Install and inspect', refresh: 'Refresh', approve: 'Approve this version and enable', review: 'Review artifact and permissions', unavailable: 'This deployment has no plugin build or artifact service.', loading: 'Reading installations…', empty: 'No external packages installed.', trust: 'Client modules execute in the workbench page. Review the source, code and permissions before approval.', nextTurn: 'Host plugins load before the next turn.', pending: 'Awaiting approval', enabled: 'Enabled', disabled: 'Disabled', code: 'Build artifacts', files: 'File permission', tools: 'Register tools', timer: 'Timers', client: 'Browser module', resolving: 'Resolving dependencies', building: 'Building', failed: 'Installation failed'};
interface Snapshot {available: boolean; installations: Installation[]; jobs: InstallJob[]}
async function operation<T>(body?: object): Promise<T> {
  const response = await fetch('package-installations', body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  const value = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
export const name = 'installed-bundle-lifecycle';
export const inject = ['slots', 'locale', 'remote', 'sidebarRight'];
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.package-installations.locale');
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({name: 'plugins.detail.section', id: 'installed-bundle-review', order: 42, locale: NS}, props => props.subject.kind === 'bundle' && props.subject.pkg ? React.createElement(Installations, {ctx, t, name: props.subject.pkg.name}) : null));
  const active = new Map<string, {digest: string; fiber: Fiber}>();
  let closed = false, pending: Promise<void> | undefined, dirty = false;
  const refresh = () => {
    if (closed) return;
    dirty = true;
    if (pending) return;
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const snapshot = await operation<Snapshot>();
        for (const [name, row] of active) if (!snapshot.installations.some(next => next.name === name && next.digest === row.digest && next.approved && next.enabled && next.permissions.client)) {active.delete(name); await row.fiber.dispose();}
        for (const row of snapshot.installations) {
          if (closed || !row.approved || !row.enabled || !row.permissions.client || active.has(row.name)) continue;
          const url = new URL(`package-assets/${row.digest}/client.js?name=${encodeURIComponent(row.name)}`, document.baseURI).href;
          const module = await import(/* @vite-ignore */ url) as {default(sdk: object): Promise<object>};
          if (closed) break;
          const plugin = await module.default({React, cordis, compose: composeInstalledBundle});
          if (closed) break;
          const fiber = ctx.plugin(plugin);
          try {await fiber.await();} catch (error) {await fiber.dispose(); throw error;}
          if (closed) {await fiber.dispose(); break;}
          active.set(row.name, {digest: row.digest, fiber});
        }
      }
    })().catch(error => {if (!closed) console.error('[weft] installed Client activation failed', error);}).finally(() => {pending = undefined; if (dirty) refresh();});
  };
  ctx.effect(() => () => {closed = true; return Promise.all([...active.values()].map(row => row.fiber.dispose()));}, 'weft.installed-clients');
  ctx.on('connection/reset', refresh); ctx.remote.$on('plugin-manager/changed', refresh); refresh();
}
function Installations({ctx, t, name}: {ctx: ClientContext; t: (key: string) => string; name: string}): React.ReactNode {
  const [snapshot, setSnapshot] = React.useState<Snapshot>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [grants, setGrants] = React.useState<Permissions>();
  const [review, setReview] = React.useState<{row: Installation; artifact: Artifact}>();
  const refresh = async () => {setSnapshot(await operation<Snapshot>());};
  const action = async (fn: () => Promise<void>) => {setBusy(true); setError(undefined); try {await fn(); await refresh();} catch (error) {setError(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}};
  React.useEffect(() => {let closed = false; const read = () => {void operation<Snapshot>().then(value => {if (!closed) setSnapshot(value);}).catch(error => {if (!closed) setError(String(error));});}; read(); return () => {closed = true;};}, []);
  const h = React.createElement;
  const row = snapshot?.installations.find(row => row.name === name);
  if (!row) return null;
  return h('div', {style: {display: 'grid', gap: 12}},
    h('p', null, t('summary')),
    error ? h('p', {role: 'alert'}, error) : null,
    snapshot?.installations.length === 0 ? h('p', null, t('empty')) : null,
    h('section', null,
      h('p', null, t(!row.approved ? 'pending' : row.enabled ? 'enabled' : 'disabled')),
      h('button', {type: 'button', disabled: busy, onClick: () => {void action(async () => {const artifact = await operation<Artifact>({operation: 'review', name: row.name, digest: row.digest}); setGrants({...artifact.permissions}); setReview({row, artifact});});}}, t('review'))),
    review ? h('section', {'aria-label': t('review')},
      h('strong', null, `${review.row.name}@${review.row.version}`),
      h('p', {style: {overflowWrap: 'anywhere'}}, `SHA-256: ${review.row.digest}`),
      h('p', null, t('trust')), h('p', null, t('nextTurn')),
      h('pre', null, JSON.stringify({patch: review.artifact.patch, capabilities: review.artifact.permissions, dependencies: review.artifact.lock.map(({name, version, integrity}) => ({name, version, integrity}))}, null, 2)),
      grants ? h('fieldset', null, h('legend', null, t('approve')),
        h('label', null, t('files'), h('select', {value: grants.files, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setGrants({...grants, files: event.target.value as Permissions['files']})}, ...['none','read','write'].map(value => h('option', {key:value,value}, value)))),
        ...(['tools','timer','client'] as const).map(key => h('label', {key}, h('input', {type:'checkbox', checked:grants[key], disabled:!review.artifact.permissions[key], onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setGrants({...grants,[key]:event.target.checked})}), t(key)))) : null,
      h('details', null, h('summary', null, t('code')), h('pre', {style: {maxHeight: 360, overflow: 'auto'}}, [review.artifact.host, review.artifact.client].filter(Boolean).join('\n\n'))),
      !review.row.approved ? h('button', {type: 'button', disabled: busy, onClick: () => {void action(async () => {await operation({operation: 'approve', name: review.row.name, digest: review.row.digest, permissions: grants}); setReview(undefined);});}}, t('approve')) : null) : null);
}
