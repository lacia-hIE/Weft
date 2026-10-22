import React from 'react';
import { SegmentedControl, SettingsForm, SettingsFormModel, settingsTextField, type SettingsFieldState, type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * The environment's workspace runtime on the Plugins page: where bash and
 * terminal commands run and the container's size, over Weft's
 * `workspace-runtime` settings namespace. It follows the official shell page
 * (a staged form over `configForms`, registered into `plugins.item`).
 */

const NS = 'weft.workspace-runtime';
/** The environment settings namespace this page edits (packages/control-plane/src/native-settings.ts). */
const SETTINGS_NS = 'workspace-runtime';
const SHELLS = ['auto', 'worker', 'container'] as const;
const SIZES = ['basic', 'standard-1', 'standard-2'] as const;

interface WorkspaceRuntime { shell?: string; containerInstance?: string }
interface CardState extends SettingsFormShell { shell: SettingsFieldState; containerInstance: SettingsFieldState }
interface Snapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }

interface SettingsContext {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: object, component: (props: CardProps) => React.ReactNode): unknown };
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): (key: string) => string };
  configForms: { get(ns: string): SettingsFormScope<WorkspaceRuntime>; whileServed(names: string[], callback: (served: ReadonlySet<string>) => unknown): () => void };
  effect(callback: () => unknown, label: string): unknown;
}
interface CardProps {
  view: 'summary' | 'detail';
  t: (key: keyof typeof zh) => string;
  useWorkspaceRuntimeCard: <T>(select: (state: CardState) => T) => T;
  edit(field: string, text: string): void;
  save(): void;
  discard(): void;
}

const zh = {
  title: '工作区运行环境',
  description: '选择命令在 Worker 还是 Linux 容器中运行，或交给 Agent 按任务选择。',
  shell: '命令运行位置',
  shellHint: '自动：从即开即用的 Worker 开始，任务需要 git、node、python 时 Agent 自行切到容器。仅 Worker：不使用容器，文件搜索（ripgrep）不可用。始终容器：完整的 Linux，支持真实终端与交互式程序，首次启动需要几秒，空闲 10 分钟后休眠。使用容器时，每轮回复会列出改动的文件。',
  auto: '自动',
  worker: '仅 Worker',
  container: '始终容器',
  containerInstance: '容器规格',
  containerInstanceHint: 'basic：1/4 vCPU、1 GiB；standard-1：1/2 vCPU、4 GiB；standard-2：1 vCPU、6 GiB。下次容器启动时生效。',
  storageHint: '源码和 .git 持久保存。容器中的 node_modules、.venv 和常见缓存只保存在容器本地，休眠后可能需要重建；Worker 和文件侧栏看不到这些本地文件。同步文件单个最大 256 MiB，大型 Git 仓库可尝试浅克隆；增大容器规格不会提高此上限。',
  readOnly: '本部署的设置为只读。',
  unavailable: '此环境暂时无法配置运行环境。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  containerControl: '容器控制',
  stopHint: '停止当前工作区容器会结束共享它的所有会话的容器任务和终端。源码和 .git 同步后保留；依赖与缓存可能需要重建。下次执行新的容器命令时重新启动。',
  stop: '停止容器',
  stopping: '正在停止容器…',
  running: '容器正在运行',
  stopped: '容器已停止',
  loading: '正在读取容器状态…',
  containerUnavailable: '本部署未提供容器。',
  refresh: '刷新容器状态',
  stopFailed: '容器操作失败，请刷新状态后重试。',
};
const en: typeof zh = {
  title: 'Workspace runtime',
  description: 'Choose whether commands run in a Worker or a Linux container, or let the agent choose for each task.',
  shell: 'Where commands run',
  shellHint: 'Auto starts in the instant Worker and lets the agent switch to the container when a task needs git, node or python. Worker only never uses the container, so file search (ripgrep) is unavailable. Always container provides a full Linux with real terminals and interactive programs, takes a few seconds to start and sleeps after 10 idle minutes. With the container, each reply lists the files it changed.',
  auto: 'Auto',
  worker: 'Worker only',
  container: 'Always container',
  containerInstance: 'Container size',
  containerInstanceHint: 'basic: 1/4 vCPU, 1 GiB; standard-1: 1/2 vCPU, 4 GiB; standard-2: 1 vCPU, 6 GiB. Applies when the container next starts.',
  storageHint: 'Source and .git persist. Container node_modules, .venv and common caches stay local and may need rebuilding after idle shutdown; the Worker and Files sidebar cannot see them. Synced files are limited to 256 MiB each. Try a shallow clone for large Git repositories; a larger container does not raise this limit.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The workspace runtime cannot be configured here right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  containerControl: 'Container control',
  stopHint: 'Stopping this workspace container ends container tasks and terminals in every session sharing it. Source and .git are retained after synchronization; dependencies and caches may need rebuilding. A new container command starts it again.',
  stop: 'Stop container',
  stopping: 'Stopping container…',
  running: 'Container is running',
  stopped: 'Container is stopped',
  loading: 'Reading container state…',
  containerUnavailable: 'This deployment has no container.',
  refresh: 'Refresh container state',
  stopFailed: 'The container operation failed. Refresh its state and try again.',
};

export const name = 'weft-workspace-runtime-settings';
export const inject = ['slots', 'locale', 'configForms'];

export function apply(ctx: SettingsContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.workspace-runtime: dictionaries');
  const form = new SettingsFormModel<WorkspaceRuntime>(ctx.configForms.get(SETTINGS_NS), [settingsTextField('shell'), settingsTextField('containerInstance')]);
  const store: Snapshot<CardState> = form.bind(() => ({...form.shell(), shell: form.field('shell'), containerInstance: form.field('containerInstance')}));
  ctx.effect(() => () => { form.dispose(); }, 'weft.workspace-runtime: form');
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'weft-workspace-runtime', order: 41, label: () => t('title'), locale: NS,
    inject: () => ({hooks: {workspaceRuntimeCard: store}, ...form.actions()}),
  }, WorkspaceRuntimeCard))), 'weft.workspace-runtime: page');
}

function Choice<Value extends string>({id, label, hint, value, options, disabled, onChange}: {id: string; label: string; hint: string; value: Value; options: {value: Value; label: string}[]; disabled: boolean; onChange: (next: Value) => void}): React.ReactNode {
  return React.createElement('div', {style: {display: 'grid', gap: 6, marginBottom: 16}},
    React.createElement('span', {id: `${id}-label`, style: {fontWeight: 500}}, label),
    React.createElement(SegmentedControl<Value>, {id, label, value, options, disabled, onChange}),
    React.createElement('span', {style: {fontSize: 12, opacity: 0.7}}, hint));
}

function WorkspaceRuntimeCard(props: CardProps): React.ReactNode {
  const {t} = props;
  const state = props.useWorkspaceRuntimeCard(snapshot => snapshot);
  if (props.view === 'summary') return t('description');
  const disabled = !state.writable;
  // An empty draft is the default the environment runs with.
  const shell = (SHELLS as readonly string[]).includes(state.shell.text) ? state.shell.text as typeof SHELLS[number] : 'auto';
  const size = (SIZES as readonly string[]).includes(state.containerInstance.text) ? state.containerInstance.text as typeof SIZES[number] : 'basic';
  return React.createElement(SettingsForm, {
    labels: {unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving')},
    state, onSave: props.save, onDiscard: props.discard,
    children: [
      React.createElement(Choice<typeof SHELLS[number]>, {key: 'shell', id: 'weft-workspace-shell', label: t('shell'), hint: t('shellHint'), value: shell, disabled,
        options: SHELLS.map(value => ({value, label: t(value)})), onChange: next => { props.edit('shell', next); }}),
      React.createElement(Choice<typeof SIZES[number]>, {key: 'size', id: 'weft-container-size', label: t('containerInstance'), hint: t('containerInstanceHint'), value: size, disabled: disabled || shell === 'worker',
        options: SIZES.map(value => ({value, label: value})), onChange: next => { props.edit('containerInstance', next); }}),
      React.createElement('p', {key: 'storage', style: {fontSize: 12, opacity: 0.7}}, t('storageHint')),
      React.createElement(ContainerControl, {key: 'container-control', t}),
    ],
  });
}

function ContainerControl({t}: {t: CardProps['t']}): React.ReactNode {
  const [state, setState] = React.useState<{available: boolean; status: 'running' | 'stopped' | 'stopping'}>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [revision, setRevision] = React.useState(0);
  const read = async (method: 'GET' | 'POST', signal?: AbortSignal) => {
    const response = await fetch('workspace-container', {method, ...(signal ? {signal} : {}), ...(method === 'POST' ? {headers: {'content-type': 'application/json'}, body: '{}'} : {})});
    const value = await response.json() as {available: boolean; status: 'running' | 'stopped' | 'stopping'; error?: string};
    if (!response.ok) throw new Error(value.error ?? t('stopFailed'));
    if (typeof value.available !== 'boolean' || !['running', 'stopped', 'stopping'].includes(value.status)) throw new Error(t('stopFailed'));
    return value;
  };
  React.useEffect(() => {
    const abort = new AbortController();
    void read('GET', abort.signal).then(value => {setState(value);}).catch(reason => {if (!abort.signal.aborted) setError(String(reason instanceof Error ? reason.message : reason));});
    return () => abort.abort();
  }, [revision]);
  const stop = async () => {
    setBusy(true); setError(undefined);
    try {setState(await read('POST'));}
    catch (reason) {setError(reason instanceof Error ? reason.message : t('stopFailed')); setRevision(value => value + 1);}
    finally {setBusy(false);}
  };
  const status = busy || state?.status === 'stopping' ? 'stopping' : !state ? 'loading' : !state.available ? 'containerUnavailable' : state.status;
  return React.createElement('section', {style: {borderTop: '1px solid currentColor', paddingTop: 16, marginTop: 20}},
    React.createElement('strong', null, t('containerControl')),
    React.createElement('p', {style: {fontSize: 12, opacity: 0.7}}, t('stopHint')),
    React.createElement('p', {role: 'status'}, t(status)),
    error ? React.createElement('p', {role: 'alert'}, error) : null,
    React.createElement('button', {type: 'button', disabled: busy || !state?.available || state.status === 'stopped', onClick: () => {void stop();}}, t('stop')),
    React.createElement('button', {type: 'button', disabled: busy, onClick: () => {setError(undefined); setRevision(value => value + 1);}, style: {marginLeft: 12}}, t('refresh')));
}
