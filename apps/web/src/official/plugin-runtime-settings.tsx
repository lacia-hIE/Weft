/** @jsxRuntime classic */
import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {Context} from '@deepseek-ai/cordis';
import {readPluginRuntime} from '../../../../packages/native-composition/src/runtime.ts';
import type {PluginRuntimeEntry, PluginRuntimeSnapshot} from '../../../../packages/native-composition/src/runtime-contract.ts';

interface Store<T> {getSnapshot(): T; subscribe(listener: () => void): () => void}
interface RuntimeContext {
  slots: {inject(name: string, callback: () => unknown): unknown; register(spec: object, component: (props: Props) => React.ReactNode): unknown};
  locale: {register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): (key: string) => string};
  effect(callback: () => unknown, label: string): unknown;
  sessions: {list: Store<{byId: Record<string, {title?: unknown}>}>};
}
const NS = 'weft.plugin-runtime';
const zh = {
  title: '插件运行诊断', description: '查看真实会话实例和当前浏览器的插件状态、缺失依赖与失败类型。',
  session: '会话', browser: '当前浏览器', refresh: '刷新状态', search: '筛选插件', loading: '正在读取运行状态…',
  inactive: '会话宿主未激活。此读取不会启动 Agent；开始使用会话后可再次检查。', missing: '会话已不可用。', empty: '请选择会话，或切换到当前浏览器。',
  failedRead: '无法读取运行状态，请刷新重试。', module: '插件 / 条目', state: '实时状态', details: '诊断',
  pending: '等待依赖', loadingPhase: '加载中', active: '运行中', failed: '加载失败', disposed: '已释放', unloading: '卸载中', disabled: '已停用', unavailable: '无运行实例',
  configError: '配置校验失败', startupError: '插件启动失败', errorHint: '具体错误文本保留在宿主日志中，避免将配置或密钥返回页面。',
  observed: '采集时间', truncated: '条目过多，当前展示前 2048 项。', note: '状态来自选定会话的实际宿主或当前页面，不代表所有会话。自动刷新每 5 秒一次；切到其他页面后停止。',
};
const en: typeof zh = {
  title: 'Plugin runtime diagnostics', description: 'Inspect actual Session and browser plugins, missing dependencies and failure types.',
  session: 'Session', browser: 'Current browser', refresh: 'Refresh status', search: 'Filter plugins', loading: 'Reading runtime state…',
  inactive: 'The Session host is inactive. This read does not start an Agent; use the Session and inspect again.', missing: 'The Session is no longer available.', empty: 'Choose a Session or switch to the current browser.',
  failedRead: 'Could not read runtime state. Refresh to retry.', module: 'Plugin / entry', state: 'Live state', details: 'Diagnostics',
  pending: 'Waiting for dependencies', loadingPhase: 'Loading', active: 'Running', failed: 'Failed to load', disposed: 'Disposed', unloading: 'Unloading', disabled: 'Disabled', unavailable: 'No runtime instance',
  configError: 'Configuration validation failed', startupError: 'Plugin startup failed', errorHint: 'Detailed error text stays in host logs so configuration and credentials are not returned to the page.',
  observed: 'Observed at', truncated: 'Too many entries; showing the first 2048.', note: 'State belongs to the selected Session owner or this page, rather than every Session. Refreshes every 5 seconds while this page is visible.',
};
type Translate = (key: keyof typeof zh) => string;
interface Props {
  view?: 'summary' | 'detail'; t: Translate;
  sessions: RuntimeContext['sessions']['list'];
  browser(): Promise<{entries: PluginRuntimeEntry[]; truncated: boolean}>;
}

export const name = 'weft-plugin-runtime-settings';
export const inject = ['slots', 'locale', 'sessions', 'loader'];
export function apply(ctx: RuntimeContext): void {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.plugin-runtime: dictionaries');
  const t = ctx.locale.bind(NS);
  const browser = () => readPluginRuntime(ctx as unknown as Context);
  const injected = () => ({sessions: ctx.sessions.list, browser});
  ctx.slots.inject('plugins.item', () => ctx.slots.register({name: 'plugins.item', id: 'weft-plugin-runtime', order: 55, label: () => t('title'), locale: NS, inject: injected}, Panel));
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({name: 'settings.plugins.tab', id: 'runtime', order: 15, label: () => t('title'), locale: NS, inject: injected}, Panel));
}

function Panel(props: Props): React.ReactNode {
  return props.view === 'summary' ? <p>{props.t('description')}</p> : <Diagnostics {...props} />;
}

function Diagnostics({t, sessions, browser}: Props): React.ReactNode {
  const roster = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const [target, setTarget] = useState('browser');
  const [snapshot, setSnapshot] = useState<PluginRuntimeSnapshot>();
  const [failure, setFailure] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let current = true, reading = false;
    const abort = new AbortController();
    setSnapshot(undefined); setFailure(false);
    const read = async () => {
      if (reading || document.visibilityState === 'hidden' || !panel.current?.getClientRects().length) return;
      reading = true;
      try {
        let value: PluginRuntimeSnapshot;
        if (target === 'browser') value = {observedAt: Date.now(), sessionId: 'browser', state: 'active', ...await browser()};
        else {
          const response = await fetch('plugins/runtime?sessionId='+encodeURIComponent(target), {signal: abort.signal, cache: 'no-store'});
          if (!response.ok) throw new Error('Runtime read failed');
          value = await response.json() as PluginRuntimeSnapshot;
        }
        if (current) {setSnapshot(value); setFailure(false);}
      } catch {if (current) setFailure(true);}
      finally {reading = false;}
    };
    void read();
    const timer = setInterval(() => {void read();}, 5000);
    const visible = () => {if (document.visibilityState === 'visible') void read();};
    document.addEventListener('visibilitychange', visible);
    return () => {current = false; clearInterval(timer); abort.abort(); document.removeEventListener('visibilitychange', visible);};
  }, [target, browser, refresh]);
  const shown = snapshot?.entries.filter(row => [row.moduleName, row.entryId, ...row.missingServices].some(text => text?.toLowerCase().includes(query.trim().toLowerCase()))) ?? [];
  return <section ref={panel} data-plugin-runtime style={{display: 'grid', gap: 12, overflowX: 'auto'}}>
    <p>{t('note')}</p>
    <label>{t('session')} <select aria-label={t('session')} value={target} onChange={event => {setTarget(event.target.value);}}>
      <option value="browser">{t('browser')}</option>
      {Object.entries(roster.byId).map(([id, row]) => <option key={id} value={id}>{typeof row.title === 'string' ? row.title : id}</option>)}
    </select></label>
    <div><button type="button" onClick={() => {setRefresh(value => value + 1);}}>{t('refresh')}</button> <input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => {setQuery(event.target.value);}} /></div>
    {failure ? <p role="alert">{t('failedRead')}</p> : null}
    {!snapshot && !failure ? <p role="status">{t('loading')}</p> : null}
    {snapshot ? <>
      <p>{t('observed')}: <time dateTime={new Date(snapshot.observedAt).toISOString()}>{new Date(snapshot.observedAt).toLocaleTimeString()}</time></p>
      {snapshot.state !== 'active' ? <p role="status">{t(snapshot.state === 'loading' ? 'loadingPhase' : snapshot.state)}{snapshot.failure ? ' · '+snapshot.failure.name : ''}</p> : <>
        <table style={{borderCollapse: 'collapse', width: '100%', fontSize: 12}}>
          <thead><tr><th>{t('module')}</th><th>{t('state')}</th><th>{t('details')}</th></tr></thead>
          <tbody>{shown.map(row => <tr key={row.id} data-runtime-plugin={row.entryId ?? row.id} data-runtime-phase={row.phase}>
            <td style={{padding: 6, overflowWrap: 'anywhere'}}><strong>{row.moduleName}</strong>{row.entryId ? <div>{row.entryId}</div> : null}</td>
            <td style={{padding: 6}}>{t(row.phase === 'loading' ? 'loadingPhase' : row.phase)}</td>
            <td style={{padding: 6}}>{row.missingServices.length ? row.missingServices.join(', ') : '—'}{row.failure ? <div>{t(row.failure.kind === 'configuration' ? 'configError' : 'startupError')}: {row.failure.name}{row.failure.code ? ' · '+row.failure.code : ''}<p>{t('errorHint')}</p></div> : null}</td>
          </tr>)}</tbody>
        </table>
        {snapshot.truncated ? <p role="status">{t('truncated')}</p> : null}
      </>}
    </> : null}
  </section>;
}
