import React from 'react';
import {Button, DisclosureRow, IconCodeOutlineRegular, Modal} from '@deepseek-ai/dsh-client-ui-primitives';
import type {JavaScriptStatus, JavaScriptList, JavaScriptSummary} from '../../../../packages/workspace/src/javascript.ts';

import {WorkerTaskStore, unfinished} from './worker-task-store.ts';
import type {WorkerPluginSettings} from '../../../../packages/worker-plugins/src/catalog.ts';

const NS = 'weft.worker-tasks';
const zh = {title: 'Worker 任务', task: 'JavaScript 任务', loading: '读取任务中…', empty: '此会话还没有 Worker 任务。', refresh: '刷新任务', cancel: '取消任务', cancelAll: '取消所有未结束任务', close: '关闭', running: '运行中', waiting: '等待审批', completed: '已完成', failed: '失败', cancelled: '已取消', expired: '已过期', preparing: '正在准备', error: '读取或取消任务失败，请刷新重试。', truncated: '输出已截断；较大的结果请保存为工作区文件。', expiry: '过期时间', details: '查看任务详情', approval: '请通过会话中的原版审批卡片答复。', output: '任务输出'};
const en: typeof zh = {title: 'Worker tasks', task: 'JavaScript task', loading: 'Loading tasks…', empty: 'This Session has no Worker tasks.', refresh: 'Refresh tasks', cancel: 'Cancel task', cancelAll: 'Cancel all unfinished tasks', close: 'Close', running: 'Running', waiting: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired', preparing: 'Preparing', error: 'Unable to read or cancel tasks. Refresh to retry.', truncated: 'Output was truncated. Save large results to a workspace file.', expiry: 'Expires', details: 'View task details', approval: 'Answer through the original approval card in this conversation.', output: 'Task output'};
type Translate = (key: keyof typeof zh) => string;
interface TasksContext {
  slots: {inject(name: string, callback: () => unknown): unknown; register<Props extends object>(spec: object, component: (props: Props) => React.ReactNode): unknown};
  locale: {register(ns: string, dictionaries: object): () => void};
  plugin(plugin: object): {dispose(): Promise<void>};
  remote: {$on(name: string, callback: () => void): unknown};
  on(name: string, callback: () => void): unknown;
  effect(callback: () => unknown, label: string): unknown;
}
interface Owner {sessionId: string; t: Translate}
interface ToolOwner extends Owner {phase: string; block: {content?: {type: string; text?: string}[]; call?: {argsRaw?: string}; argsRaw?: string; isError?: boolean}}
const section: React.CSSProperties = {display: 'grid', gap: 8, padding: '12px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)'};
const outputStyle: React.CSSProperties = {margin: 0, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, background: 'var(--dsw-alias-markdown-code-block)', borderRadius: 8};

export const name = '@weft/worker-task-management';
export const inject = ['slots', 'locale', 'remote'];
export function apply(ctx: TasksContext): void {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.worker-tasks: dictionaries');
  let cards: {dispose(): Promise<void>} | undefined;
  let closed = false, revision = 0;
  const reconcile = async () => {
    const current = ++revision;
    try {
      const response = await fetch('worker-plugins');
      if (!response.ok) return;
      const settings = await response.json() as WorkerPluginSettings;
      if (closed || current !== revision) return;
      const enabled = settings.bundles.javascript && settings.cards.enabled;
      if (enabled && !cards) cards = ctx.plugin(TaskCards);
      else if (!enabled && cards) {const old = cards; cards = undefined; await old.dispose();}
    } catch { /* Keep the last known UI on a transient connection failure. */ }
  };
  ctx.remote.$on('settings/document-updated', () => {void reconcile();});
  ctx.remote.$on('plugin-manager/changed', () => {void reconcile();});
  ctx.on('connection/reset', () => {void reconcile();});
  ctx.effect(() => () => {closed = true; revision++; for (const store of stores.values()) store.stop(); stores.clear();}, 'weft.worker-tasks: lifetime');
  void reconcile();
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({name: 'conversation.session.header.utilities', id: 'weft-worker-tasks', order: -6, locale: NS}, TaskCatalog));
}

const TaskCards = {name: '@weft/worker-task-cards', inject: ['slots'], apply(ctx: TasksContext) {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({name: 'tool.call.toolview', key: 'javascript_task', locale: NS}, TaskToolCard));
}};

async function request(sessionId: string, operation: 'list' | 'status' | 'cancel' | 'cancelAll', id?: string, signal?: AbortSignal): Promise<JavaScriptList | JavaScriptStatus> {
  const mutation = operation === 'cancel' || operation === 'cancelAll';
  const query = new URLSearchParams({sessionId, ...(id ? {id} : {})});
  const response = await fetch(mutation ? 'javascript-tasks' : 'javascript-tasks?'+query, {
    ...(signal ? {signal} : {}),
    ...(mutation ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId, operation, ...(id ? {id} : {})})} : {}),
  });
  if (!response.ok) throw new Error('Task request failed');
  return await response.json() as JavaScriptList | JavaScriptStatus;
}

const stores = new Map<string, WorkerTaskStore>();
function useTasks(sessionId: string, enabled: boolean, id?: string, details = false) {
  const key = location.pathname+':'+sessionId;
  const store = React.useMemo(() => {
    let store = stores.get(key);
    if (!store) {store = new WorkerTaskStore(sessionId, request, () => document.hidden, () => {}); stores.set(key, store);}
    return store;
  }, [key, sessionId]);
  const subscribe = React.useCallback((listener: () => void) => enabled ? store.subscribe(listener, id, details) : () => {}, [store, enabled, id, details]);
  const state = React.useSyncExternalStore(subscribe, store.getSnapshot);
  React.useEffect(() => {
    if (!enabled) return;
    const visible = () => store.refresh(false);
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [store, enabled]);
  return {...state, refresh: () => store.refresh(), cancel: store.cancel};
}

function CatalogTask({sessionId, task, t, cancel, busy}: Owner & {task: JavaScriptSummary; cancel(id: string): Promise<void>; busy: boolean}): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const state = useTasks(sessionId, open, task.id, true);
  return React.createElement('section', {style: section, 'data-task-id': task.id},
    React.createElement(DisclosureRow, {title: task.id, open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value), collapsedContent: React.createElement('span', {role: 'status'}, t(task.status)),
      headerAccessory: unfinished(task) ? React.createElement(Button, {variant: 'outline', size: 'sm', disabled: busy, onClick: () => {void cancel(task.id);}}, t('cancel')) : null,
      children: state.details.has(task.id) ? React.createElement(TaskDetails, {task: state.details.get(task.id)!, t}) : React.createElement('p', {role: state.error ? 'alert' : 'status'}, t(state.error ? 'error' : 'loading'))}));
}

function TaskDetails({task, t}: {task: JavaScriptStatus; t: Translate}): React.ReactNode {
  return React.createElement('div', {style: {display: 'grid', gap: 8}},
    React.createElement('code', {style: {fontSize: 11, overflowWrap: 'anywhere'}}, task.id),
    task.expiresAt ? React.createElement('small', null, `${t('expiry')}: ${new Date(task.expiresAt).toLocaleString()}`) : null,
    ...task.pending.map(call => React.createElement('p', {key: call.callId, style: {margin: 0}}, call.reason)),
    task.status === 'waiting' ? React.createElement('small', null, t('approval')) : null,
    task.error ? React.createElement('p', {role: 'alert', style: {margin: 0, color: 'var(--dsw-alias-label-error)'}}, `${task.error.code}: ${task.error.message}`) : null,
    task.stdout || task.stderr || task.value !== undefined ? React.createElement('pre', {'aria-label': t('output'), style: outputStyle}, [task.stdout, task.stderr, task.value === undefined ? '' : JSON.stringify(task.value, null, 2)].filter(Boolean).join('\n')) : null,
    task.outputTruncated ? React.createElement('small', null, t('truncated')) : null);
}

function TaskCatalog({sessionId, t}: Owner): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const state = useTasks(sessionId, open);
  return React.createElement(React.Fragment, null,
    React.createElement(Button, {variant: 'toolbar', size: 'sm', title: t('title'), 'aria-label': t('title'), onClick: () => setOpen(true), icon: React.createElement(IconCodeOutlineRegular, {size: 16})}),
    React.createElement(Modal, {open, onClose: () => setOpen(false), title: t('title'), closeLabel: t('close'), children:
      React.createElement('div', {style: {display: 'grid', gap: 12}},
        React.createElement('div', {style: {display: 'flex', flexWrap: 'wrap', gap: 8}},
          React.createElement(Button, {variant: 'outline', size: 'sm', disabled: state.busy, onClick: state.refresh}, t('refresh')),
          React.createElement(Button, {variant: 'outline', size: 'sm', disabled: state.busy || !state.value?.tasks.some(unfinished), onClick: () => {void state.cancel();}}, t('cancelAll'))),
        state.error ? React.createElement('p', {role: 'alert'}, t('error')) : null,
        !state.value && !state.error ? React.createElement('p', {role: 'status'}, t('loading')) : null,
        state.value?.tasks.length === 0 ? React.createElement('p', null, t('empty')) : null,
        React.createElement('div', {style: {maxHeight: '60vh', overflow: 'auto'}}, ...state.value?.tasks.map(task => React.createElement(CatalogTask, {key: task.id, sessionId, task, t, cancel: state.cancel, busy: state.busy})) ?? []))}));
}

function TaskToolCard({sessionId, block, phase, t}: ToolOwner): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  let recorded: JavaScriptStatus | undefined;
  for (const item of block.content ?? []) {
    if (item.type !== 'text' || !item.text) continue;
    try {const value = JSON.parse(item.text) as JavaScriptStatus; if (typeof value.id === 'string' && typeof value.status === 'string' && Array.isArray(value.pending)) recorded = value;} catch {}
  }
  const live = useTasks(sessionId, recorded !== undefined && (open || unfinished(recorded)), recorded?.id, open);
  const detail = recorded ? live.details.get(recorded.id) : undefined;
  const task = live.value?.tasks.find(task => task.id === recorded?.id) ?? recorded;
  return React.createElement('div', {'data-tool': 'javascript_task'},
    React.createElement(DisclosureRow, {title: t('task'), icon: React.createElement(IconCodeOutlineRegular, {size: 14}), open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      running: !task && phase !== 'result', onToggle: () => setOpen(value => !value),
      collapsedContent: React.createElement('span', {role: 'status', style: {marginLeft: 8}}, task ? t(task.status) : block.isError ? t('failed') : t(phase === 'preparing' ? 'preparing' : 'title')),
      headerAccessory: React.createElement(TaskCatalog, {sessionId, t}),
      children: React.createElement('div', {style: section},
        live.error ? React.createElement('p', {role: 'alert'}, t('error')) : null,
        open && detail ? React.createElement(TaskDetails, {task: detail, t}) : open && recorded ? React.createElement('p', {role: live.error ? 'alert' : 'status'}, t(live.error ? 'error' : 'loading')) : null,
        React.createElement('div', {style: {display: 'flex', gap: 8}},
          React.createElement(Button, {variant: 'outline', size: 'sm', disabled: live.busy || !recorded, onClick: live.refresh}, t('refresh')),
          task && unfinished(task) ? React.createElement(Button, {variant: 'outline', size: 'sm', disabled: live.busy, onClick: () => {void live.cancel(task.id);}}, t('cancel')) : null))}));
}
