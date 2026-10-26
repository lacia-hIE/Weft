import React from 'react';
import * as cordis from '@deepseek-ai/cordis';
import {Button, Checkbox, Input, SegmentedControl} from '@deepseek-ai/dsh-client-ui-primitives';
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
const zh = {title: '插件审核', reinstall: '请移除此旧版安装记录，再通过“添加插件”以原版 dsh.bundle.patch 重新安装。', summary: '审核原版 dsh.bundle.patch、构建产物和宿主能力。', spec: '插件包与精确版本', install: '安装并检查', refresh: '刷新', approve: '批准此版本并启用', review: '查看产物与权限', unavailable: '本部署未提供插件构建或存储服务。', loading: '正在读取安装记录…', empty: '尚未安装外部插件包。', trust: 'Client 模块会在工作台页面执行。批准前请确认来源、代码与所需权限。', nextTurn: 'Host 插件在下一轮运行前加载。', pending: '等待审批', enabled: '已启用', disabled: '已停用', code: '构建产物', files: '文件权限', tools: '注册工具', timer: '定时器', client: '浏览器模块', resolving: '解析依赖', building: '构建中', failed: '安装失败', update: '构建更新版本', version: '目标版本', reviewUpdate: '审核更新', discard: '放弃此更新', rollback: '恢复上一版本', current: '当前版本', previous: '上一版本', resources: '样式与静态资源', updating: '新版本将在审核批准后替换当前版本。', none: '无', read: '只读', write: '读写'};
const en: typeof zh = {title: 'Bundle review', reinstall: 'Remove this legacy installation and reinstall its native dsh.bundle.patch through Add plugin.', summary: 'Review the original dsh.bundle.patch, compiled artifacts and Host capabilities.', spec: 'Package and exact version', install: 'Install and inspect', refresh: 'Refresh', approve: 'Approve this version and enable', review: 'Review artifact and permissions', unavailable: 'This deployment has no plugin build or artifact service.', loading: 'Reading installations…', empty: 'No external packages installed.', trust: 'Client modules execute in the workbench page. Review the source, code and permissions before approval.', nextTurn: 'Host plugins load before the next turn.', pending: 'Awaiting approval', enabled: 'Enabled', disabled: 'Disabled', code: 'Build artifacts', files: 'File permission', tools: 'Register tools', timer: 'Timers', client: 'Browser module', resolving: 'Resolving dependencies', building: 'Building', failed: 'Installation failed', update: 'Build update', version: 'Target version', reviewUpdate: 'Review update', discard: 'Discard update', rollback: 'Restore previous version', current: 'Current version', previous: 'Previous version', resources: 'Styles and static assets', updating: 'The current version stays selected until you approve the update.', none: 'None', read: 'Read only', write: 'Read and write'};
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
    const artifact=await operation<Artifact>({operation:'review',name:row.name,digest:target.digest});setGrants({...artifact.permissions});setReview({row:target,artifact});
  });
  const reviewCurrent=review && [row.digest,row.candidate?.digest].includes(review.row.digest);
  const codeStyle={maxHeight:320,overflow:'auto',fontFamily:'var(--ds-font-family-code)',fontSize:12} as const;
  return h('div', {style: {display: 'grid', gap: 16, minWidth:0}},
    h('p', null, t('summary')),
    error || row.lastError || job?.phase==='failed' ? h('p', {role:'alert'}, error ?? row.lastError ?? job?.error) : null,
    h('section', {style:{display:'grid',gap:8}},
      h('p', null, `${t('current')}: ${row.version} · `, h('span',null,t(row.needsReinstall ? 'reinstall' : !row.approved ? 'pending' : row.enabled ? 'enabled' : 'disabled'))),
      h('div', {style:{display:'flex',gap:8,flexWrap:'wrap'}},
        h(Button, {variant:'outline', disabled: busy || row.needsReinstall, onClick:()=>showReview(row)},t('review')),
        row.previous?.approved ? h(Button,{variant:'outline',disabled:busy||Boolean(row.candidate),onClick:()=>void action(async()=>{await operation({operation:'rollback',name,digest:row.digest});setReview(undefined);})},`${t('rollback')} (${row.previous.version})`):null)),
    row.candidate ? h('section', {style:{display:'grid',gap:8},'aria-label':t('reviewUpdate')},
      h('strong',null,`${name}@${row.candidate.version}`),h('p',null,t('updating')),
      h('div',{style:{display:'flex',gap:8}},
        h(Button,{variant:'primary',disabled:busy,onClick:()=>showReview(row.candidate!)},t('reviewUpdate')),
        h(Button,{variant:'outline',disabled:busy,onClick:()=>void action(async()=>{await operation({operation:'discard',name,digest:row.candidate!.digest});setReview(undefined);})},t('discard')))) :
      h('section',{style:{display:'grid',gap:8}},
        h('label',{htmlFor:id+'-version'},t('version')),
        h('div',{style:{display:'flex',gap:8,alignItems:'center'}},
          h(Input,{id:id+'-version',value:version,placeholder:row.version,disabled:busy||building,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setVersion(event.target.value)}),
          h(Button,{variant:'outline',disabled:busy||building||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim()),onClick:()=>void action(async()=>{await operation({operation:'install',spec:`${name}@${version.trim()}`,requestId:crypto.randomUUID()});setVersion('');})},t('update'))),
        building&&job ? h('p',{role:'status'},t(job.phase)) : null),
    reviewCurrent ? h('section', {'aria-label': t('review'),style:{display:'grid',gap:12,minWidth:0}},
      h('strong', null, `${review.row.name}@${review.row.version}`),
      h('p', {style: {overflowWrap: 'anywhere'}}, `SHA-256: ${review.row.digest}`),
      h('p', null, t('trust')), h('p', null, t('nextTurn')),
      h('pre', {style:codeStyle}, JSON.stringify({patch: review.artifact.patch, capabilities: review.artifact.permissions, dependencies: review.artifact.lock.map(({name, version, integrity}) => ({name, version, integrity}))}, null, 2)),
      grants ? h('fieldset', {style:{display:'grid',gap:12}}, h('legend', null, t('approve')),
        h('div',null,h('p',null,t('files')),h(SegmentedControl<Permissions['files']>,{id:id+'-files',label:t('files'),value:grants.files,options:(['none','read','write'] as const).map(value=>({value,label:t(value),disabled:value==='write'&&review.artifact.permissions.files!=='write'||value==='read'&&review.artifact.permissions.files==='none'})),onChange:files=>setGrants({...grants,files})})),
        ...(['tools','timer','client'] as const).map(key => h(Checkbox, {key, label:t(key),checked:grants[key],disabled:!review.artifact.permissions[key],onChange:checked=>setGrants({...grants,[key]:checked})}))) : null,
      h('details',null,h('summary',null,t('resources')),h('pre',{style:codeStyle},review.artifact.css??''),h('ul',null,...Object.entries(review.artifact.assets??{}).map(([path,bytes])=>h('li',{key:path},`${path} · ${Math.floor(bytes.length*3/4)} B`)))),
      h('details', null, h('summary', null, t('code')), h('pre', {style:codeStyle}, [review.artifact.host, review.artifact.client].filter(Boolean).join('\n\n'))),
      !review.row.approved ? h(Button, {variant:'primary', disabled: busy, onClick: () => {void action(async () => {await operation({operation: 'approve', name: review.row.name, digest: review.row.digest, permissions: grants}); setReview(undefined);});}}, t('approve')) : null) : null);
}
