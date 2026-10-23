import React from 'react';
import type {Installation, InstallJob, Artifact} from '../../../../packages/package-install/src/contracts.ts';

interface Fiber {dispose(): Promise<void>}
interface ClientContext {
  slots: {inject(name: string, callback: () => unknown): unknown; register(spec: object, component: (props: {view: string}) => React.ReactNode): unknown};
  locale: {register(ns: string, dictionaries: object): () => void; bind(ns: string): (key: string) => string};
  remote: {$on(name: string, callback: () => void): unknown};
  effect(callback: () => unknown, label: string): unknown;
  on(name: string, callback: () => void): unknown;
  plugin(plugin: object): Fiber;
  sidebarRight: {mounted: {getSnapshot(): string | undefined}};
}
const NS = 'weft.package-installations';
const zh = {title: '插件包安装', summary: '安装兼容 Weft 的 npm 插件包，检查构建产物并批准权限。', spec: '插件包与精确版本', install: '安装并检查', refresh: '刷新', approve: '批准此版本并启用', review: '查看产物与权限', unavailable: '本部署未提供插件构建或存储服务。', loading: '正在读取安装记录…', empty: '尚未安装外部插件包。', trust: 'Client 模块会在工作台页面执行。批准前请确认来源、代码与所需权限。', nextTurn: 'Host 插件在下一轮运行前加载。', pending: '等待审批', enabled: '已启用', disabled: '已停用', code: '构建产物', files: '文件权限', tools: '注册工具', timer: '定时器', client: '浏览器模块', resolving: '解析依赖', building: '构建中', failed: '安装失败'};
const en: typeof zh = {title: 'Package installations', summary: 'Install compatible npm plugins, review build artifacts and approve permissions.', spec: 'Package and exact version', install: 'Install and inspect', refresh: 'Refresh', approve: 'Approve this version and enable', review: 'Review artifact and permissions', unavailable: 'This deployment has no plugin build or artifact service.', loading: 'Reading installations…', empty: 'No external packages installed.', trust: 'Client modules execute in the workbench page. Review the source, code and permissions before approval.', nextTurn: 'Host plugins load before the next turn.', pending: 'Awaiting approval', enabled: 'Enabled', disabled: 'Disabled', code: 'Build artifacts', files: 'File permission', tools: 'Register tools', timer: 'Timers', client: 'Browser module', resolving: 'Resolving dependencies', building: 'Building', failed: 'Installation failed'};
interface Snapshot {available: boolean; installations: Installation[]; jobs: InstallJob[]}
async function operation<T>(body?: object): Promise<T> {
  const response = await fetch('package-installations', body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  const value = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
export const name = 'weft-package-installations';
export const inject = ['slots', 'locale', 'remote', 'sidebarRight'];
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.package-installations.locale');
  ctx.slots.inject('plugins.item', () => ctx.slots.register({name: 'plugins.item', id: 'weft-package-installations', order: 42, label: () => t('title'), locale: NS}, props => props.view === 'summary' ? t('summary') : React.createElement(Installations, {ctx, t})));
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
        for (const [name, row] of active) if (!snapshot.installations.some(next => next.name === name && next.digest === row.digest && next.approved && next.enabled)) {active.delete(name); await row.fiber.dispose();}
        for (const row of snapshot.installations) {
          if (closed || !row.approved || !row.enabled || !row.permissions.client || active.has(row.name)) continue;
          const url = new URL(`package-assets/${row.digest}/client.js?name=${encodeURIComponent(row.name)}`, document.baseURI).href;
          const module = await import(/* @vite-ignore */ url) as {default(sdk: object): Promise<object>};
          if (closed) break;
          const plugin = await module.default({React, host: {call: async (method: string, args: unknown = null) => {
            const sessionId = ctx.sidebarRight.mounted.getSnapshot();
            if (!sessionId) throw new Error('Open a Session before invoking a package');
            const response = await fetch('package-invoke', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId, name: row.name, digest: row.digest, method, args})});
            const result = await response.json() as {value?: unknown; error?: string};
            if (!response.ok) throw new Error(result.error ?? 'Package invocation failed');
            return result.value;
          }}});
          if (closed) break;
          const fiber = ctx.plugin(plugin); active.set(row.name, {digest: row.digest, fiber});
        }
      }
    })().catch(error => {if (!closed) console.error('[weft] installed Client activation failed', error);}).finally(() => {pending = undefined; if (dirty) refresh();});
  };
  ctx.effect(() => () => {closed = true; return Promise.all([...active.values()].map(row => row.fiber.dispose()));}, 'weft.installed-clients');
  ctx.on('connection/reset', refresh); ctx.remote.$on('plugin-manager/changed', refresh); refresh();
}
function Installations({ctx, t}: {ctx: ClientContext; t: (key: string) => string}): React.ReactNode {
  const [snapshot, setSnapshot] = React.useState<Snapshot>();
  const [spec, setSpec] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [review, setReview] = React.useState<{row: Installation; artifact: Artifact}>();
  const refresh = async () => {setSnapshot(await operation<Snapshot>());};
  const action = async (fn: () => Promise<void>) => {setBusy(true); setError(undefined); try {await fn(); await refresh();} catch (error) {setError(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}};
  React.useEffect(() => {let closed = false; const read = () => {void operation<Snapshot>().then(value => {if (!closed) setSnapshot(value);}).catch(error => {if (!closed) setError(String(error));});}; read(); return () => {closed = true;};}, []);
  // Active jobs are durable; polling belongs to this installation form only and stops on completion/unmount.
  const running = snapshot?.jobs.some(job => ['building', 'resolving'].includes(job.phase));
  React.useEffect(() => {if (!running) return; const timer = setInterval(() => {void refresh().catch(error => setError(String(error)));}, 1500); return () => clearInterval(timer);}, [running]);
  const h = React.createElement;
  return h('div', {style: {display: 'grid', gap: 12}},
    h('p', null, t('summary')),
    !snapshot ? h('p', {role: 'status'}, t('loading')) : !snapshot.available ? h('p', {role: 'status'}, t('unavailable')) : null,
    h('label', null, t('spec'), h('input', {value: spec, placeholder: '@scope/plugin@1.2.3', disabled: busy || running || !snapshot?.available, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSpec(event.target.value)})),
    h('div', null,
      h('button', {type: 'button', disabled: busy || running || !spec.trim() || !snapshot?.available, onClick: () => {void action(async () => {await operation({operation: 'install', spec: spec.trim(), requestId: crypto.randomUUID()});});}}, t('install')),
      h('button', {type: 'button', disabled: busy, onClick: () => {void action(refresh);}}, t('refresh'))),
    error ? h('p', {role: 'alert'}, error) : null,
    snapshot?.installations.length === 0 ? h('p', null, t('empty')) : null,
    ...snapshot?.jobs.filter(job => job.phase !== 'review').slice(0, 4).map(job => h('p', {key: job.id, role: 'status'}, `${job.spec}: ${t(job.phase)}${job.error ? ': ' + job.error : ''}`)) ?? [],
    ...snapshot?.installations.map(row => h('section', {key: row.name, style: {borderTop: '1px solid currentColor', paddingTop: 12}},
      h('strong', null, `${row.name}@${row.version}`), h('p', null, row.description),
      h('p', null, t(!row.approved ? 'pending' : row.enabled ? 'enabled' : 'disabled')),
      h('button', {type: 'button', disabled: busy, onClick: () => {void action(async () => {setReview({row, artifact: await operation<Artifact>({operation: 'review', name: row.name, digest: row.digest})});});}}, t('review')))) ?? [],
    review ? h('section', {'aria-label': t('review')},
      h('strong', null, `${review.row.name}@${review.row.version}`),
      h('p', {style: {overflowWrap: 'anywhere'}}, `SHA-256: ${review.row.digest}`),
      h('p', null, t('trust')), h('p', null, t('nextTurn')),
      h('pre', null, JSON.stringify({permissions: review.artifact.permissions, dependencies: review.artifact.lock.map(({name, version, integrity}) => ({name, version, integrity}))}, null, 2)),
      h('details', null, h('summary', null, t('code')), h('pre', {style: {maxHeight: 360, overflow: 'auto'}}, [review.artifact.host, review.artifact.client].filter(Boolean).join('\n\n'))),
      !review.row.approved ? h('button', {type: 'button', disabled: busy, onClick: () => {void action(async () => {await operation({operation: 'approve', name: review.row.name, digest: review.row.digest}); setReview(undefined);});}}, t('approve')) : null) : null);
}
