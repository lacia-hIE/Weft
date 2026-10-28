import React from 'react';
import * as cordis from '@deepseek-ai/cordis';
import {Button, Input, SegmentedControl, Switch, Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import * as ui from '@deepseek-ai/dsh-client-ui-primitives';
import {composeInstalledBundle} from '../../../../packages/package-install/src/composition.ts';
import type {Installation, InstallJob, Artifact, Permissions, PackageRevision} from '../../../../packages/package-install/src/contracts.ts';
import {RefreshQueue} from '../../../../packages/plugin-registry/src/refresh.ts';

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
const zh = {title: '插件审核', reinstall: '请移除此旧版安装记录，再通过“添加插件”以原版 dsh.bundle.patch 重新安装。', summary: '审核原版 dsh.bundle.patch、构建产物和宿主能力。', spec: '插件包与精确版本', install: '安装并检查', refresh: '刷新', approve: '批准此版本并启用', reapprove: '更新授权并启用', review: '审核产物与授权', unavailable: '本部署未提供插件构建或存储服务。', loading: '正在读取安装记录…', empty: '尚未安装外部插件包。', trust: 'Client 模块会在工作台页面执行。批准前请确认来源、代码与所需权限。', nextTurn: 'Host 插件在下一轮运行前加载。', pending: '等待审批', enabled: '已启用', disabled: '已停用', code: '构建产物', files: '文件权限', tools: '注册工具', timer: '定时器', client: '浏览器模块', resolving: '解析依赖', building: '构建中', failed: '安装失败', update: '构建更新版本', version: '目标版本', reviewUpdate: '审核更新', discard: '放弃此更新', rollback: '恢复上一版本', current: '当前版本', previous: '上一版本', resources: '样式与静态资源', updating: '新版本将在审核批准后替换当前版本。', routes: '公开 Webhook 入口（插件负责验签）', network: '访问外部 HTTPS 服务', storage: '插件持久状态', sessions: '管理本环境会话', credentials: '读取本环境凭据', background: '环境后台运行', connections: '外部长连接', environmentHost: '此插件在环境中运行，不依赖打开会话页面。', none: '无', read: '只读', write: '读写', whereEnvironment: '环境后台', whereSession: '会话内', where: '运行位置', digest: '产物摘要', failureTitle: '激活失败', failedState: '激活失败', closeReview: '收起审核', versions: '版本', versionHint: '输入精确版本号构建更新；新版本需重新审核后才会替换当前版本。', provenance: '来源', source: '包与版本', capabilities: '能力授权', capabilitiesHint: '只授予需要的能力；未授予的能力会让依赖它的组件保持挂起。', entries: '组件', dependencies: '依赖', sources: '原始内容', patch: 'dsh.bundle.patch', grantCount: '将授予的能力', cancel: '取消', approvedDigest: '已审批', 'risk-high': '高风险', 'risk-medium': '中风险', 'risk-low': '低风险', 'about-files': '读取或修改环境工作区中的文件。', 'about-tools': '向 Agent 注册可调用的工具。', 'about-timer': '按计划定时运行代码。', 'about-client': '在工作台页面中加载浏览器模块，与页面同等信任。', 'about-network': '向公网 HTTPS 服务发起请求和长连接，所有请求经平台出口检查。', 'about-storage': '保存插件自己的持久数据。', 'about-sessions': '在本环境创建会话、发送消息并读取回复。', 'about-credentials': '读取本环境中保存的凭据值。', 'about-routes': '对外开放 /v1/plugin-hooks 下的路由，来源校验由插件负责。', 'about-background': '在环境中常驻运行，不依赖打开的会话页面。', 'about-connections': '由平台共享网关保持对外 WebSocket 和长轮询，有消息时才唤醒本环境。'};
const en: typeof zh = {title: 'Bundle review', reinstall: 'Remove this legacy installation and reinstall its native dsh.bundle.patch through Add plugin.', summary: 'Review the original dsh.bundle.patch, compiled artifacts and Host capabilities.', spec: 'Package and exact version', install: 'Install and inspect', refresh: 'Refresh', approve: 'Approve this version and enable', reapprove: 'Update permissions and enable', review: 'Review artifact and grants', unavailable: 'This deployment has no plugin build or artifact service.', loading: 'Reading installations…', empty: 'No external packages installed.', trust: 'Client modules execute in the workbench page. Review the source, code and permissions before approval.', nextTurn: 'Host plugins load before the next turn.', pending: 'Awaiting approval', enabled: 'Enabled', disabled: 'Disabled', code: 'Build artifacts', files: 'File permission', tools: 'Register tools', timer: 'Timers', client: 'Browser module', resolving: 'Resolving dependencies', building: 'Building', failed: 'Installation failed', update: 'Build update', version: 'Target version', reviewUpdate: 'Review update', discard: 'Discard update', rollback: 'Restore previous version', current: 'Current version', previous: 'Previous version', resources: 'Styles and static assets', updating: 'The current version stays selected until you approve the update.', routes: 'Public Webhook routes (plugin verifies signatures)', network: 'External HTTPS requests', storage: 'Persistent plugin state', sessions: 'Manage environment sessions', credentials: 'Read environment credentials', background: 'Run in the environment background', connections: 'Persistent outbound connections', environmentHost: 'This plugin runs in the environment, independently of open session pages.', none: 'None', read: 'Read only', write: 'Read and write', whereEnvironment: 'Environment background', whereSession: 'In Sessions', where: 'Runs', digest: 'Artifact digest', failureTitle: 'Activation failed', failedState: 'Activation failed', closeReview: 'Close review', versions: 'Versions', versionHint: 'Build an exact version as an update; it replaces the current version only after you approve it.', provenance: 'Provenance', source: 'Package and version', capabilities: 'Capabilities', capabilitiesHint: 'Grant only what is needed; components that need an ungranted capability stay parked.', entries: 'Components', dependencies: 'Dependencies', sources: 'Sources', patch: 'dsh.bundle.patch', grantCount: 'Capabilities to grant', cancel: 'Cancel', approvedDigest: 'Approved', 'risk-high': 'High risk', 'risk-medium': 'Medium risk', 'risk-low': 'Low risk', 'about-files': 'Read or change files in the environment workspace.', 'about-tools': 'Register tools the Agent can call.', 'about-timer': 'Run code on a schedule.', 'about-client': 'Load a browser module in the workbench, trusted like the page itself.', 'about-network': 'Make requests and long-lived connections to public HTTPS services through the platform egress.', 'about-storage': 'Keep the plugin\'s own persistent data.', 'about-sessions': 'Create Sessions in this environment, send messages and read replies.', 'about-credentials': 'Read credential values stored in this environment.', 'about-routes': 'Expose routes under /v1/plugin-hooks; the plugin verifies their sources.', 'about-background': 'Keep running in the environment without an open Session page.', 'about-connections': 'Hold outbound WebSockets and long polls in the shared platform gateway, waking this environment only for messages.'};
interface Snapshot {available: boolean; installations: Installation[]; jobs: InstallJob[]}
async function operation<T>(body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('package-installations', {...(signal ? {signal} : {}), ...(body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
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
  const active = new Map<string, {digest: string; authority: string; fiber: Fiber}>();
  const queue = new RefreshQueue(async current => {
    const snapshot = await operation<Snapshot>();
    if (!current()) return;
    const installations = new Map(snapshot.installations.map(row => [row.name, row]));
    for (const [name, row] of active) {
      if (!current()) return;
      const next = installations.get(name);
      if (!next || next.digest !== row.digest || !next.approved || !next.enabled || !next.permissions.client || JSON.stringify([next.activationId,next.permissions]) !== row.authority) {active.delete(name); await row.fiber.dispose();}
    }
    for (const row of snapshot.installations) {
      if (!current()) return;
      if (!row.approved || !row.enabled || !row.permissions.client || active.has(row.name)) continue;
      try {
        const url = new URL(`package-assets/${row.digest}/client.js?name=${encodeURIComponent(row.name)}`, document.baseURI).href;
        const asset = (path: string) => new URL(path, url).href;
        const module = await import(/* @vite-ignore */ url) as {stylesheet?: boolean; default(sdk: object): Promise<cordis.Plugin>};
        if (!current()) return;
        const plugin = await module.default({React, cordis, ui, compose: composeInstalledBundle, asset,
          css: (source: string) => source.replace(/__WEFT_ASSET__\/(assets\/[A-Z0-9]+\.[a-z0-9]+)/gi, (_,path: string)=>asset(path))});
        if (!current()) return;
        const fiber = ctx.plugin({name: 'installed-client-resources', inject: plugin.inject, async apply(client: cordis.Context) {
          if (module.stylesheet) {
            await new Promise<void>((resolve,reject) => {
              client.effect(() => {
                const link = document.createElement('link'); link.rel='stylesheet'; link.href=asset('client.css');
                link.dataset.plugin=`installed:${row.name}`; link.dataset.pluginCss=row.digest;
                const timer=setTimeout(()=>reject(new Error('Plugin stylesheet timed out')),15000);
                link.onload=()=>{clearTimeout(timer);resolve();}; link.onerror=()=>{clearTimeout(timer);reject(new Error('Plugin stylesheet could not load'));};
                document.head.appendChild(link);
                return ()=>{clearTimeout(timer);link.remove();reject(new Error('Plugin stylesheet activation stopped'));};
              }, 'installed-client: stylesheet');
            });
          }
          await client.plugin(plugin).await();
        }});
        try {await fiber.await();} catch (error) {await fiber.dispose(); throw error;}
        if (!current()) {await fiber.dispose(); return;}
        active.set(row.name, {digest: row.digest, authority: JSON.stringify([row.activationId,row.permissions]), fiber});
      } catch (error) {
        if (!current()) return;
        console.error('[weft] installed Client activation failed', row.name, error);
        const result=await operation<{changed:boolean}>({operation:'client-failed',name:row.name,digest:row.digest,activationId:row.activationId});
        if (result.changed) queue.refresh();
      }
    }
  }, error => {console.error('[weft] installed Client activation failed', error);});
  ctx.effect(() => () => queue.close().then(()=>Promise.all([...active.values()].map(row => row.fiber.dispose()))), 'weft.installed-clients');
  ctx.on('connection/reset', queue.refresh); ctx.remote.$on('plugin-manager/changed', queue.refresh); queue.refresh();
}
function Installations({ctx, t, name}: {ctx: ClientContext; t: (key: string) => string; name: string}): React.ReactNode {
  const [snapshot, setSnapshot] = React.useState<Snapshot>();
  const [busy, setBusy] = React.useState(false), [version, setVersion] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [grants, setGrants] = React.useState<Permissions>();
  const [review, setReview] = React.useState<{row: PackageRevision; artifact: Artifact}>();
  const id=React.useId();
  const refresh = async () => {setSnapshot(await operation<Snapshot>());};
  const action = async (fn: () => Promise<void>) => {setBusy(true); setError(undefined); try {await fn(); await refresh();} catch (error) {setError(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}};
  React.useEffect(() => {
    let closed=false, running=false, dirty=false, timer:ReturnType<typeof setTimeout>|undefined;
    const abort=new AbortController();
    const read=async()=>{
      clearTimeout(timer); if(closed || document.hidden)return;
      if(running){dirty=true;return;}
      running=true;dirty=false;
      let interval:number|undefined;
      try {
        const value=await operation<Snapshot>(undefined,abort.signal);
        if(!closed) {setSnapshot(value);setError(undefined);if(value.jobs.some(job=>['resolving','building'].includes(job.phase)))interval=1500;}
      } catch(error) {if(!closed){setError(String(error));interval=5000;}}
      finally{running=false;if(!closed&&!document.hidden&&(dirty||interval!==undefined))timer=setTimeout(()=>void read(),dirty?0:interval);}
    };
    const dispose=ctx.remote.$on('plugin-manager/changed',()=>void read());
    document.addEventListener('visibilitychange',read); void read();
    return()=>{closed=true;abort.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',read);if(typeof dispose==='function')dispose();};
  }, [ctx,name]);
  const h = React.createElement;
  const row = snapshot?.installations.find(row => row.name === name);
  if (!row) return null;
  const job=snapshot?.jobs.find(job=>job.name===name || job.spec===name || job.spec.startsWith(name+'@'));
  const building=snapshot?.jobs.some(job=>['resolving','building'].includes(job.phase));
  const showReview=(target:PackageRevision)=>void action(async()=>{
    const artifact=await operation<Artifact>({operation:'review',name:row.name,digest:target.digest});setGrants(target.approved ? {...target.permissions} : {...artifact.permissions, network:false, credentials:false, routes:false, connections:false});setReview({row:target,artifact});
  });
  const reviewCurrent=review && [row.digest,row.candidate?.digest].includes(review.row.digest);
  const grantsChanged=review && grants && Object.keys(review.artifact.permissions).some(key=>grants[key as keyof Permissions] !== review.row.permissions[key as keyof Permissions]);
  const failure=error ?? row.lastError ?? (job?.phase==='failed' ? job.error : undefined);
  const status=row.needsReinstall ? ['reinstall','warning'] as const : !row.approved ? ['pending','warning'] as const : row.enabled ? ['enabled','success'] as const : row.lastError ? ['failedState','danger'] as const : ['disabled','neutral'] as const;
  const where=row.hostScope==='environment' ? t('whereEnvironment') : t('whereSession');
  return h('div', {style: styles.stack},
    h('section', {style: styles.card},
      h('header', {style: styles.cardHeader},
        h('div', {style: styles.titleBlock}, h('strong', {style: styles.title}, t('title')), h('span', {style: styles.caption}, t('summary'))),
        h(Tag, {tone: status[1]}, t(status[0]))),
      h('dl', {style: styles.facts},
        fact(h, t('current'), h('span', null, `v${row.version}`)),
        fact(h, t('where'), where),
        fact(h, t('digest'), h('code', {style: styles.mono, title: row.digest}, shortDigest(row.digest)))),
      failure ? h('div', {role: 'alert', style: styles.danger}, h('strong', null, t('failureTitle')), h('span', {style: styles.wrap}, failure)) : null,
      h('div', {style: styles.actions},
        h(Button, {variant: reviewCurrent && review.row.digest === row.digest ? 'outline' : 'primary', disabled: busy || row.needsReinstall,
          onClick: () => reviewCurrent && review.row.digest === row.digest ? setReview(undefined) : showReview(row)}, t(reviewCurrent && review.row.digest === row.digest ? 'closeReview' : 'review')),
        row.previous?.approved ? h(Button, {variant: 'outline', disabled: busy || Boolean(row.candidate), onClick: () => void action(async () => {await operation({operation: 'rollback', name, digest: row.digest}); setReview(undefined);})}, `${t('rollback')} · v${row.previous.version}`) : null)),
    reviewCurrent && grants ? h(ReviewPanel, {h, t, id, busy, review, grants, setGrants, needsApproval: !review.row.approved || Boolean(grantsChanged) || !row.enabled && review.row.digest === row.digest,
      onCancel: () => setReview(undefined), onApprove: () => void action(async () => {await operation({operation: 'approve', name: review.row.name, digest: review.row.digest, permissions: grants}); setReview(undefined);})}) : null,
    h('section', {style: styles.card},
      h('header', {style: styles.cardHeader}, h('div', {style: styles.titleBlock}, h('strong', {style: styles.title}, t('versions')), h('span', {style: styles.caption}, t(row.candidate ? 'updating' : 'versionHint'))),
        building && job ? h(Tag, {tone: 'info'}, t(job.phase)) : null),
      row.candidate ? h('div', {style: styles.candidate},
        h('div', {style: styles.titleBlock}, h('strong', null, `v${row.candidate.version}`), h('code', {style: styles.mono, title: row.candidate.digest}, shortDigest(row.candidate.digest))),
        h('div', {style: styles.actions},
          h(Button, {variant: 'primary', disabled: busy, onClick: () => showReview(row.candidate!)}, t('reviewUpdate')),
          h(Button, {variant: 'outline', disabled: busy, onClick: () => void action(async () => {await operation({operation: 'discard', name, digest: row.candidate!.digest}); setReview(undefined);})}, t('discard')))) :
        h('div', {style: styles.fact}, h('label', {htmlFor: id + '-version', style: styles.factLabel}, t('version')), h('div', {style: styles.inline},
          h(Input, {id: id + '-version', value: version, placeholder: `v${row.version}`, disabled: busy || building, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setVersion(event.target.value)}),
          h(Button, {variant: 'outline', disabled: busy || building || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim()), onClick: () => void action(async () => {await operation({operation: 'install', spec: `${name}@${version.trim()}`, requestId: crypto.randomUUID()}); setVersion('');})}, t('update'))))));
}

type Render = typeof React.createElement;
const RISK: Record<keyof Permissions, 'high' | 'medium' | 'low'> = {files: 'medium', tools: 'low', timer: 'low', client: 'medium', network: 'high', storage: 'low', sessions: 'high', credentials: 'high', routes: 'medium', background: 'low', connections: 'high'};
const RISK_TONE = {high: 'danger', medium: 'warning', low: 'neutral'} as const;
const shortDigest = (digest: string) => `${digest.slice(0, 12)}…${digest.slice(-6)}`;
function fact(h: Render, label: string, value: React.ReactNode): React.ReactNode {
  return h('div', {style: styles.fact}, h('dt', {style: styles.factLabel}, label), h('dd', {style: styles.factValue}, value));
}

/** The exact artifact under review: provenance, capability grants, entries and dependencies, raw sources last. */
function ReviewPanel({h, t, id, busy, review, grants, setGrants, needsApproval, onCancel, onApprove}: {
  h: Render; t: (key: string) => string; id: string; busy: boolean; review: {row: PackageRevision; artifact: Artifact};
  grants: Permissions; setGrants: (next: Permissions) => void; needsApproval: boolean; onCancel(): void; onApprove(): void;
}): React.ReactNode {
  const {row, artifact} = review, requested = artifact.permissions;
  const keys = (['network', 'connections', 'routes', 'sessions', 'credentials', 'storage', 'background', 'tools', 'timer', 'client'] as const).filter(key => ['tools', 'timer', 'client'].includes(key) || requested[key]);
  const granted = keys.filter(key => grants[key]).length + Number(grants.files !== 'none');
  const entries = (artifact.rows as {id?: unknown; name?: unknown; group?: unknown; config?: unknown}[]).flatMap(function leaves(entry): {id: string; name: string}[] {
    return entry.group && Array.isArray(entry.config) ? (entry.config as typeof artifact.rows).flatMap(leaves as never) : [{id: String(entry.id), name: String(entry.name)}];
  });
  const capability = (key: keyof Permissions, control: React.ReactNode, first: boolean) => h('li', {key, style: {...styles.capability, ...(first ? {borderTop: 'none'} : {})}},
    h('div', {style: styles.capabilityText},
      h('div', {style: styles.capabilityTitle}, h('span', null, t(key)), h(Tag, {tone: RISK_TONE[RISK[key]]}, t('risk-' + RISK[key]))),
      h('span', {style: styles.caption}, t('about-' + key))),
    control);
  const disclosure = (title: string, body: React.ReactNode) => h('details', {style: styles.details}, h('summary', {style: styles.summary}, title), body);
  return h('section', {'aria-label': t('review'), style: {...styles.card, ...styles.reviewCard}},
    h('header', {style: styles.cardHeader},
      h('div', {style: styles.titleBlock}, h('strong', {style: styles.title}, `${row.name}`), h('span', {style: styles.caption}, `v${row.version} · ${artifact.hostScope === 'environment' ? t('whereEnvironment') : t('whereSession')}`)),
      h(Tag, {tone: row.approved ? 'success' : 'warning'}, t(row.approved ? 'approvedDigest' : 'pending'))),
    h('div', {style: styles.note}, h('span', null, artifact.hostScope === 'environment' ? t('environmentHost') : t('nextTurn')), h('span', null, t('trust'))),
    h('div', {style: styles.section},
      h('h4', {style: styles.sectionTitle}, t('provenance')),
      h('dl', {style: styles.facts},
        fact(h, 'SHA-256', h('code', {style: {...styles.mono, ...styles.wrap}}, row.digest)),
        fact(h, t('source'), h('code', {style: styles.mono}, `${row.name}@${row.version}`)))),
    h('div', {style: styles.section},
      h('div', {style: styles.sectionHeader}, h('h4', {style: styles.sectionTitle}, t('capabilities')), h('span', {style: styles.caption}, t('capabilitiesHint'))),
      h('ul', {style: styles.list},
        requested.files !== 'none' ? capability('files', h('div', {style: styles.segment}, h(SegmentedControl<Permissions['files']>, {id: id + '-files', label: t('files'), value: grants.files,
          options: (['none', 'read', 'write'] as const).map(value => ({value, label: t(value), disabled: value === 'write' && requested.files !== 'write'})), onChange: files => setGrants({...grants, files})})), true) : null,
        ...keys.map((key, index) => capability(key, h(Switch, {checked: grants[key] === true, label: t(key), disabled: !requested[key], onChange: (checked: boolean) => setGrants({...grants, [key]: checked})}), index === 0 && requested.files === 'none')))),
    entries.length ? h('div', {style: styles.section},
      h('h4', {style: styles.sectionTitle}, `${t('entries')} · ${entries.length}`),
      h('table', {style: styles.table}, h('tbody', null, ...entries.map(entry => h('tr', {key: entry.id, style: styles.tableRow},
        h('td', {style: styles.cellStrong}, entry.id), h('td', {style: {...styles.cell, ...styles.mono}}, entry.name)))))) : null,
    h('div', {style: styles.section},
      h('h4', {style: styles.sectionTitle}, `${t('dependencies')} · ${artifact.lock.length}`),
      h('table', {style: styles.table}, h('tbody', null, ...artifact.lock.map(item => h('tr', {key: item.name, style: styles.tableRow},
        h('td', {style: styles.cellStrong}, item.name), h('td', {style: styles.cell}, `v${item.version}`),
        h('td', {style: {...styles.cell, ...styles.mono}, title: item.integrity}, `${item.integrity.slice(0, 18)}…`)))))),
    h('div', {style: styles.section},
      h('h4', {style: styles.sectionTitle}, t('sources')),
      disclosure(t('patch'), h('pre', {style: styles.code}, JSON.stringify(artifact.patch, null, 2))),
      disclosure(t('code'), h('pre', {style: styles.code}, [artifact.host, artifact.client].filter(Boolean).join('\n\n') || '—')),
      artifact.css || artifact.assets ? disclosure(t('resources'), h('div', null,
        artifact.css ? h('pre', {style: styles.code}, artifact.css) : null,
        h('ul', {style: styles.assetList}, ...Object.entries(artifact.assets ?? {}).map(([path, bytes]) => h('li', {key: path}, h('code', {style: styles.mono}, path), ` · ${Math.floor(bytes.length * 3 / 4)} B`))))) : null),
    h('footer', {style: styles.footer},
      h('span', {style: styles.caption}, `${t('grantCount')}: ${granted}`),
      h('div', {style: styles.actions},
        h(Button, {variant: 'outline', disabled: busy, onClick: onCancel}, t('cancel')),
        needsApproval ? h(Button, {variant: 'primary', disabled: busy, onClick: onApprove}, t(row.approved ? 'reapprove' : 'approve')) : null)));
}

const border = '1px solid var(--dsw-alias-border-l2)';
const styles = {
  stack: {display: 'grid', gap: 16, minWidth: 0},
  card: {display: 'grid', gap: 16, padding: 20, border, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-2)', minWidth: 0},
  reviewCard: {borderColor: 'var(--dsw-alias-border-l3)'},
  cardHeader: {display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  titleBlock: {display: 'grid', gap: 4, minWidth: 0},
  title: {fontSize: 15, color: 'var(--dsw-alias-label-primary)'},
  caption: {fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)'},
  facts: {display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, margin: 0},
  fact: {display: 'grid', gap: 4, minWidth: 0},
  factLabel: {fontSize: 12, color: 'var(--dsw-alias-label-tertiary)'},
  factValue: {margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-primary)', minWidth: 0},
  mono: {fontFamily: 'var(--dsw-font-mono, var(--ds-font-family-code))', fontSize: 12, color: 'var(--dsw-alias-label-secondary)'},
  wrap: {overflowWrap: 'anywhere'},
  danger: {display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)', fontSize: 13, color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)'},
  note: {display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))', background: 'var(--dsw-alias-state-warn-tertiary)'},
  actions: {display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center'},
  inline: {display: 'flex', gap: 8, alignItems: 'center'},
  candidate: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'},
  section: {display: 'grid', gap: 10, paddingTop: 16, borderTop: border, minWidth: 0},
  sectionHeader: {display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'},
  sectionTitle: {margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)'},
  list: {listStyle: 'none', margin: 0, padding: 0, display: 'grid', border, borderRadius: 'var(--dsw-radius-md)', overflow: 'hidden'},
  capability: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 14px', borderTop: border, background: 'var(--dsw-alias-bg-layer-3)'},
  capabilityText: {display: 'grid', gap: 4, minWidth: 0},
  capabilityTitle: {display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)'},
  segment: {flexShrink: 0},
  table: {width: '100%', borderCollapse: 'collapse', fontSize: 13, border, borderRadius: 'var(--dsw-radius-md)', overflow: 'hidden'},
  tableRow: {borderTop: border},
  cell: {padding: '8px 12px', color: 'var(--dsw-alias-label-secondary)', verticalAlign: 'top', overflowWrap: 'anywhere'},
  cellStrong: {padding: '8px 12px', color: 'var(--dsw-alias-label-primary)', verticalAlign: 'top', whiteSpace: 'nowrap'},
  details: {border, borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-3)'},
  summary: {cursor: 'pointer', padding: '10px 12px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)'},
  code: {margin: 0, maxHeight: 320, overflow: 'auto', padding: 12, borderTop: border, fontFamily: 'var(--dsw-font-mono, var(--ds-font-family-code))', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre'},
  assetList: {margin: 0, padding: '8px 12px 12px 28px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)'},
  footer: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingTop: 16, borderTop: border, position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-layer-2)'},
} satisfies Record<string, React.CSSProperties>;
