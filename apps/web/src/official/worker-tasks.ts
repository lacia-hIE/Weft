import React from 'react';
import {Button, DisclosureRow, IconCodeOutlineRegular, Modal} from '@deepseek-ai/dsh-client-ui-primitives';
import type {JavaScriptStatus, JavaScriptList} from '../../../../packages/workspace/src/javascript.ts';

const NS = 'weft.worker-tasks';
const zh = {title: 'Worker 任务', task: 'JavaScript 任务', loading: '读取任务中…', empty: '此会话还没有 Worker 任务。', refresh: '刷新任务', cancel: '取消任务', cancelAll: '取消所有未结束任务', close: '关闭', running: '运行中', waiting: '等待审批', completed: '已完成', failed: '失败', cancelled: '已取消', expired: '已过期', preparing: '正在准备', error: '读取或取消任务失败，请刷新重试。', truncated: '输出已截断；较大的结果请保存为工作区文件。', expiry: '过期时间', details: '查看任务详情', approval: '请通过会话中的原版审批卡片答复。', output: '任务输出'};
const en: typeof zh = {title: 'Worker tasks', task: 'JavaScript task', loading: 'Loading tasks…', empty: 'This Session has no Worker tasks.', refresh: 'Refresh tasks', cancel: 'Cancel task', cancelAll: 'Cancel all unfinished tasks', close: 'Close', running: 'Running', waiting: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired', preparing: 'Preparing', error: 'Unable to read or cancel tasks. Refresh to retry.', truncated: 'Output was truncated. Save large results to a workspace file.', expiry: 'Expires', details: 'View task details', approval: 'Answer through the original approval card in this conversation.', output: 'Task output'};
type Translate = (key: keyof typeof zh) => string;
interface TasksContext {
  slots: {inject(name: string, callback: () => unknown): unknown; register<Props extends object>(spec: object, component: (props: Props) => React.ReactNode): unknown};
  locale: {register(ns: string, dictionaries: object): () => void};
  effect(callback: () => unknown, label: string): unknown;
}
interface Owner {sessionId: string; t: Translate}
interface ToolOwner extends Owner {phase: string; block: {content?: {type: string; text?: string}[]; call?: {argsRaw?: string}; argsRaw?: string; isError?: boolean}}
const unfinished = (task: JavaScriptStatus) => task.status === 'running' || task.status === 'waiting';
const section: React.CSSProperties = {display: 'grid', gap: 8, padding: '12px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)'};
const outputStyle: React.CSSProperties = {margin: 0, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, background: 'var(--dsw-alias-background-secondary)', borderRadius: 8};

export const name = 'weft-worker-tasks';
export const inject = ['slots', 'locale'];
export function apply(ctx: TasksContext): void {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.worker-tasks: dictionaries');
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({name: 'tool.call.toolview', key: 'javascript_task', locale: NS}, TaskToolCard));
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({name: 'conversation.session.header.utilities', id: 'weft-worker-tasks', order: -6, locale: NS}, TaskCatalog));
}

async function request(sessionId: string, operation: 'list' | 'status' | 'cancel' | 'cancelAll', id?: string, signal?: AbortSignal): Promise<JavaScriptList> {
  const mutation = operation === 'cancel' || operation === 'cancelAll';
  const query = new URLSearchParams({sessionId, ...(id ? {id} : {})});
  const response = await fetch(mutation ? 'javascript-tasks' : 'javascript-tasks?'+query, {
    ...(signal ? {signal} : {}),
    ...(mutation ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId, operation, ...(id ? {id} : {})})} : {}),
  });
  if (!response.ok) throw new Error('Task request failed');
  const value = await response.json() as JavaScriptList | JavaScriptStatus;
  return 'tasks' in value ? value : {tasks: [value]};
}

/** No polling while closed or hidden; one awaited read precedes each timer. */
function useTasks(sessionId: string, enabled: boolean, id?: string) {
  const owner = sessionId+':'+(id ?? '*');
  const [snapshot, setSnapshot] = React.useState<{owner: string; value: JavaScriptList}>();
  const value = snapshot?.owner === owner ? snapshot.value : undefined;
  const [error, setError] = React.useState(false);
  const [mutationError, setMutationError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {setError(false); setMutationError(false);}, [sessionId, id]);
  React.useEffect(() => {
    if (!enabled || busy) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (document.hidden || abort.signal.aborted) return;
      try {
        const next = await request(sessionId, id ? 'status' : 'list', id, abort.signal);
        if (abort.signal.aborted) return;
        setSnapshot({owner, value: next}); setError(false);
        if (next.tasks.some(unfinished)) timer = setTimeout(() => {void read();}, next.tasks.some(task => task.status === 'running') ? 3000 : 15000);
      } catch {if (!abort.signal.aborted) setError(true);}
    };
    const visible = () => {clearTimeout(timer); abort.abort(); refresh();};
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => {abort.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible);};
  }, [sessionId, enabled, id, revision, busy]);
  const cancel = async (task?: string) => {
    setBusy(true); setMutationError(false);
    try {setSnapshot({owner, value: await request(sessionId, task ? 'cancel' : 'cancelAll', task)});}
    catch {setMutationError(true);}
    finally {setBusy(false); refresh();}
  };
  return {value, error: error || mutationError, busy, refresh: () => {setMutationError(false); refresh();}, cancel};
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
        React.createElement('div', {style: {maxHeight: '60vh', overflow: 'auto'}}, ...state.value?.tasks.map(task => React.createElement('section', {key: task.id, style: section, 'data-task-id': task.id},
          React.createElement('div', {style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8}},
            React.createElement('span', {role: 'status'}, t(task.status)),
            unfinished(task) ? React.createElement(Button, {variant: 'outline', size: 'sm', disabled: state.busy, onClick: () => {void state.cancel(task.id);}}, t('cancel')) : null),
          React.createElement(TaskDetails, {task, t}))) ?? []))}));
}

function TaskToolCard({sessionId, block, phase, t}: ToolOwner): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  let recorded: JavaScriptStatus | undefined;
  for (const item of block.content ?? []) {
    if (item.type !== 'text' || !item.text) continue;
    try {const value = JSON.parse(item.text) as JavaScriptStatus; if (typeof value.id === 'string' && typeof value.status === 'string' && Array.isArray(value.pending)) recorded = value;} catch {}
  }
  const live = useTasks(sessionId, recorded !== undefined && (open || unfinished(recorded)), recorded?.id);
  const task = live.value?.tasks.find(task => task.id === recorded?.id) ?? recorded;
  return React.createElement('div', {'data-tool': 'javascript_task'},
    React.createElement(DisclosureRow, {title: t('task'), icon: React.createElement(IconCodeOutlineRegular, {size: 14}), open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      running: !task && phase !== 'result', onToggle: () => setOpen(value => !value),
      collapsedContent: React.createElement('span', {role: 'status'}, task ? t(task.status) : block.isError ? t('failed') : t(phase === 'preparing' ? 'preparing' : 'title')),
      headerAccessory: React.createElement(TaskCatalog, {sessionId, t}),
      children: React.createElement('div', {style: section},
        live.error ? React.createElement('p', {role: 'alert'}, t('error')) : null,
        task ? React.createElement(TaskDetails, {task, t}) : null,
        React.createElement('div', {style: {display: 'flex', gap: 8}},
          React.createElement(Button, {variant: 'outline', size: 'sm', disabled: live.busy || !recorded, onClick: live.refresh}, t('refresh')),
          task && unfinished(task) ? React.createElement(Button, {variant: 'outline', size: 'sm', disabled: live.busy, onClick: () => {void live.cancel(task.id);}}, t('cancel')) : null))}));
}
