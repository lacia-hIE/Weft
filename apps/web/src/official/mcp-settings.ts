import React from 'react';
import { Button, Input, Switch, type SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * Settings → MCP servers: the environment's remote MCP servers over Weft's
 * `mcp-servers` settings namespace (packages/native-mcp). Each edit is one
 * revision-fenced path write, so a header value is sent only when typed and
 * never read back; the Host validates every saved list.
 */

const NS = 'weft.mcp-servers';
/** The environment settings namespace this page edits (packages/native-mcp/src/index.ts). */
const SETTINGS_NS = 'mcp-servers';
const DEFAULT_TIMEOUT_MS = 60_000;
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface Server { name: string; url: string; headers?: Record<string, string>; toolCallTimeoutMs?: number; enabled?: boolean }
interface Servers { servers?: Server[] }
interface Secret { path: readonly string[]; set: boolean }
interface Store<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Described { view?: { namespaces: readonly { ns: string; secrets?: readonly Secret[] }[] } }
interface McpContext {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: object, component: (props: { t: Translate }) => React.ReactNode): unknown };
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): Translate };
  configForms: { get(ns: string): SettingsFormScope<Servers>; describe(): Store<Described>; whileServed(names: string[], callback: (served: ReadonlySet<string>) => unknown): () => void };
  effect(callback: () => unknown, label: string): unknown;
}
type Translate = (key: keyof typeof zh) => string;
type Op = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] };

const zh = {
  title: 'MCP 服务器',
  description: '远程 MCP 服务器通过 Streamable HTTP 连接，它们的工具以 mcp__<名称>__<工具> 出现在每个会话中，包括 dsh-superagent 的执行会话。需要本地进程的 stdio 服务器在这里不可用。',
  empty: '还没有 MCP 服务器。',
  add: '添加服务器',
  github: '填入 GitHub 预设',
  githubHint: 'GitHub 官方远程 MCP：在 Authorization 填写 Bearer 加 fine-grained token，只授权需要的仓库。X-MCP-Toolsets 限定工具组。',
  name: '名称',
  nameHint: '字母、数字、- 或 _，最多 32 个字符；保存后不能修改。',
  url: 'URL',
  urlHint: '公网 https:// 地址。',
  timeout: '单次调用时限（毫秒）',
  enabled: '启用',
  headers: '请求头',
  headersHint: '值只写不读：保存后不再显示，留空表示保持原值。',
  headerName: '名称',
  headerValue: '值',
  headerSet: '已设置',
  replace: '新值（留空保持不变）',
  showValue: '显示值',
  hideValue: '隐藏值',
  addHeader: '添加请求头',
  removeHeader: '删除请求头',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  remove: '删除服务器',
  confirmRemove: '确认删除',
  keep: '保留',
  saved: '已保存，下一轮对话前生效。',
  rejected: '保存被拒绝：检查名称是否重复、URL 是否为公网 https 地址、请求头名称是否有效。',
  invalidName: '名称只能包含字母、数字、- 或 _，最多 32 个字符，且不能重复。',
  invalidHeader: '请求头名称无效。',
  readOnly: '本部署的设置为只读。',
  unavailable: '此环境暂时无法配置 MCP 服务器。',
};
const en: typeof zh = {
  title: 'MCP servers',
  description: 'Remote MCP servers connect over Streamable HTTP; their tools appear as mcp__<name>__<tool> in every Session, including dsh-superagent\'s worker Sessions. stdio servers need a local process and are not available here.',
  empty: 'No MCP servers yet.',
  add: 'Add server',
  github: 'Fill in the GitHub preset',
  githubHint: 'GitHub\'s hosted MCP: set Authorization to Bearer and a fine-grained token limited to the repositories it needs. X-MCP-Toolsets limits the tool groups.',
  name: 'Name',
  nameHint: 'Letters, digits, - or _, at most 32 characters; it cannot change after saving.',
  url: 'URL',
  urlHint: 'A public https:// address.',
  timeout: 'Limit per call (ms)',
  enabled: 'Enabled',
  headers: 'Request headers',
  headersHint: 'Values are write-only: they are not shown after saving, and an empty field keeps the stored value.',
  headerName: 'Name',
  headerValue: 'Value',
  headerSet: 'Set',
  replace: 'New value (empty keeps it)',
  showValue: 'Show value',
  hideValue: 'Hide value',
  addHeader: 'Add header',
  removeHeader: 'Remove header',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  remove: 'Remove server',
  confirmRemove: 'Confirm removal',
  keep: 'Keep',
  saved: 'Saved; it applies before the next turn.',
  rejected: 'The deployment refused it: check that the name is unique, the URL is a public https address, and the header names are valid.',
  invalidName: 'Use letters, digits, - or _, at most 32 characters, and a name no other server has.',
  invalidHeader: 'A header name is invalid.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'MCP servers cannot be configured here right now.',
};

export const name = 'weft-mcp-settings';
export const inject = ['slots', 'locale', 'configForms'];

export function apply(ctx: McpContext): void {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.mcp-servers: dictionaries');
  const scope = ctx.configForms.get(SETTINGS_NS), described = ctx.configForms.describe();
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'weft-mcp-servers', order: 22, label: () => ctx.locale.bind(NS)('title'), locale: NS,
  }, ({t}) => React.createElement(McpServers, {t, scope, described})))), 'weft.mcp-servers: section');
}

const h = React.createElement;
const muted = {margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)'} as const;
const row = {display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8} as const;
const card = {display: 'grid', gap: 12, padding: 16, borderRadius: 12, border: '0.5px solid var(--dsw-alias-border-l3)'} as const;

function useStore<T>(store: Store<T>): T {
  return React.useSyncExternalStore(React.useCallback(listener => store.subscribe(listener), [store]), React.useCallback(() => store.getSnapshot(), [store]));
}
/** A field whose single control is named by its label alone; the hint describes it. */
function Labeled({label, hint, children}: {label: string; hint?: string; children?: React.ReactElement<{id?: string; 'aria-describedby'?: string}>}): React.ReactNode {
  const id = React.useId();
  return h('div', {style: {display: 'grid', gap: 6}}, h('label', {htmlFor: id, style: {fontWeight: 500, fontSize: 13}}, label),
    children ? React.cloneElement(children, {id, ...hint ? {'aria-describedby': `${id}-hint`} : {}}) : null, hint ? h('span', {id: `${id}-hint`, style: muted}, hint) : null);
}

/** One write and its outcome, shared by the cards and the add form. */
function useWrite(scope: SettingsFormScope<Servers>, t: Translate) {
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState<{error: boolean; text: string}>();
  const write = async (ops: Op[]): Promise<boolean> => {
    if (!ops.length) return true;
    setBusy(true); setMessage(undefined);
    try {
      const accepted = await scope.mutate(ops as never, scope.getSnapshot().revision);
      setMessage(accepted ? {error: false, text: t('saved')} : {error: true, text: t('rejected')});
      return accepted;
    } catch {setMessage({error: true, text: t('rejected')}); return false;}
    finally {setBusy(false);}
  };
  return {busy, message, setMessage, write};
}
function Notice({message}: {message: {error: boolean; text: string} | undefined}): React.ReactNode {
  return message ? h('p', {role: message.error ? 'alert' : 'status', style: {...muted, color: message.error ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-secondary)'}}, message.text) : null;
}

function McpServers({t, scope, described}: {t: Translate; scope: SettingsFormScope<Servers>; described: Store<Described>}): React.ReactNode {
  const snapshot = useStore(scope), description = useStore(described);
  const [adding, setAdding] = React.useState(false);
  if (snapshot.status !== 'ready') return h('p', {style: muted}, t('unavailable'));
  const servers = snapshot.value?.servers ?? [];
  const secrets = description.view?.namespaces.find(item => item.ns === SETTINGS_NS)?.secrets ?? [];
  // Header values are redacted from the value; their names come from the secret positions.
  const headerNames = (index: number) => secrets.filter(secret => secret.path[0] === 'servers' && secret.path[1] === String(index) && secret.path[2] === 'headers' && secret.path.length === 4)
    .map(secret => ({key: secret.path[3]!, set: secret.set}));
  const disabled = !snapshot.writable;
  return h('section', {'aria-label': t('title'), style: {display: 'grid', gap: 16}},
    h('h3', {style: {margin: 0}}, t('title')), h('p', {style: muted}, t('description')),
    disabled ? h('p', {style: muted}, t('readOnly')) : null,
    servers.length ? servers.map((server, index) => h(ServerCard, {key: server.name, t, scope, server, index, headers: headerNames(index), disabled}))
      : h('p', {style: muted}, t('empty')),
    adding ? h(AddServer, {t, scope, taken: servers.map(server => server.name), onClose: () => setAdding(false)})
      : h('div', {style: row}, h(Button, {variant: 'primary', size: 'sm', disabled, onClick: () => setAdding(true)}, t('add'))));
}

function ServerCard({t, scope, server, index, headers, disabled}: {t: Translate; scope: SettingsFormScope<Servers>; server: Server; index: number; headers: {key: string; set: boolean}[]; disabled: boolean}): React.ReactNode {
  const base = ['servers', String(index)];
  const {busy, message, setMessage, write} = useWrite(scope, t);
  const [url, setUrl] = React.useState(server.url), [timeout, setTimeoutMs] = React.useState(String(server.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS));
  const [replaced, setReplaced] = React.useState<Record<string, string>>({}), [added, setAdded] = React.useState<{key: string; value: string}[]>([]);
  const [removing, setRemoving] = React.useState(false);
  React.useEffect(() => {setUrl(server.url); setTimeoutMs(String(server.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS));}, [server.url, server.toolCallTimeoutMs]);
  const save = async () => {
    if (added.some(item => !HEADER.test(item.key.trim()))) {setMessage({error: true, text: t('invalidHeader')}); return;}
    const ops: Op[] = [];
    if (url.trim() !== server.url) ops.push({op: 'set', path: [...base, 'url'], value: url.trim()});
    const ms = Number(timeout);
    if (Number.isFinite(ms) && ms !== (server.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS)) ops.push({op: 'set', path: [...base, 'toolCallTimeoutMs'], value: Math.round(ms)});
    for (const [key, value] of Object.entries(replaced)) if (value) ops.push({op: 'set', path: [...base, 'headers', key], value});
    for (const item of added) if (item.key.trim()) ops.push({op: 'set', path: [...base, 'headers', item.key.trim()], value: item.value});
    if (await write(ops)) {setReplaced({}); setAdded([]);}
  };
  return h('article', {'aria-label': server.name, style: card},
    h('div', {style: {...row, justifyContent: 'space-between'}}, h('strong', null, server.name),
      h(Switch, {label: t('enabled'), checked: server.enabled !== false, disabled: disabled || busy, onChange: next => {void write([{op: 'set', path: [...base, 'enabled'], value: next}]);}})),
    h(Labeled, {label: t('url'), hint: t('urlHint')}, h(Input, {value: url, disabled, spellCheck: false, onChange: event => setUrl(event.target.value)})),
    h(Labeled, {label: t('timeout')}, h(Input, {type: 'number', min: 1000, max: 600000, value: timeout, disabled, onChange: event => setTimeoutMs(event.target.value)})),
    h('div', {style: {display: 'grid', gap: 8}}, h('span', {style: {fontWeight: 500, fontSize: 13}}, t('headers')), h('span', {style: muted}, t('headersHint')),
      headers.map(header => h('div', {key: header.key, style: row}, h('code', {style: {minWidth: 140}}, header.key), h('span', {style: muted}, header.set ? t('headerSet') : ''),
        h(SecretInput, {t, label: `${header.key} ${t('replace')}`, placeholder: t('replace'), value: replaced[header.key] ?? '', disabled,
          onChange: value => setReplaced(previous => ({...previous, [header.key]: value}))}),
        h(Button, {variant: 'ghost', size: 'sm', disabled: disabled || busy, onClick: () => {void write([{op: 'unset', path: [...base, 'headers', header.key]}]);}}, t('removeHeader')))),
      h(HeaderRows, {t, rows: added, setRows: setAdded, disabled})),
    h('div', {style: row},
      h(Button, {variant: 'primary', size: 'sm', disabled: disabled || busy, onClick: () => {void save();}}, t(busy ? 'saving' : 'save')),
      removing ? [h(Button, {key: 'keep', variant: 'outline', size: 'sm', disabled: busy, onClick: () => setRemoving(false)}, t('keep')),
        h(Button, {key: 'confirm', variant: 'outline', size: 'sm', disabled: busy, onClick: () => {void write([{op: 'unset', path: base}]);}}, t('confirmRemove'))]
        : h(Button, {variant: 'outline', size: 'sm', disabled: disabled || busy, onClick: () => setRemoving(true)}, t('remove'))),
    h(Notice, {message}));
}

/** Eye and crossed eye, drawn with the current text colour. */
function EyeIcon({crossed}: {crossed: boolean}): React.ReactNode {
  return h('svg', {width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true},
    h('path', {d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'}), h('circle', {cx: 12, cy: 12, r: 3}), crossed ? h('path', {d: 'M3 3l18 18'}) : null);
}
/** A header value being typed: masked by default, shown while its eye button is pressed. Stored values are never read back. */
function SecretInput({t, label, placeholder, value, disabled, onChange}: {t: Translate; label: string; placeholder: string; value: string; disabled: boolean; onChange: (next: string) => void}): React.ReactNode {
  const [shown, setShown] = React.useState(false);
  return h('span', {style: {display: 'inline-flex', alignItems: 'center', gap: 4}},
    h(Input, {type: shown ? 'text' : 'password', autoComplete: 'off', spellCheck: false, 'aria-label': label, placeholder, value, disabled, onChange: event => onChange(event.target.value)}),
    h(Button, {variant: 'ghost', size: 'sm', 'aria-label': t(shown ? 'hideValue' : 'showValue'), 'aria-pressed': shown, title: t(shown ? 'hideValue' : 'showValue'), disabled,
      onClick: () => setShown(previous => !previous)}, h(EyeIcon, {crossed: shown})));
}

function HeaderRows({t, rows, setRows, disabled}: {t: Translate; rows: {key: string; value: string}[]; setRows: (next: {key: string; value: string}[]) => void; disabled: boolean}): React.ReactNode {
  const edit = (index: number, patch: Partial<{key: string; value: string}>) => setRows(rows.map((item, at) => at === index ? {...item, ...patch} : item));
  return h(React.Fragment, null,
    rows.map((item, index) => h('div', {key: index, style: row},
      h(Input, {'aria-label': t('headerName'), placeholder: t('headerName'), value: item.key, disabled, spellCheck: false, onChange: event => edit(index, {key: event.target.value})}),
      h(SecretInput, {t, label: t('headerValue'), placeholder: t('headerValue'), value: item.value, disabled, onChange: value => edit(index, {value})}),
      h(Button, {variant: 'ghost', size: 'sm', disabled, onClick: () => setRows(rows.filter((_item, at) => at !== index))}, t('removeHeader')))),
    h('div', {style: row}, h(Button, {variant: 'outline', size: 'sm', disabled, onClick: () => setRows([...rows, {key: '', value: ''}])}, t('addHeader'))));
}

function AddServer({t, scope, taken, onClose}: {t: Translate; scope: SettingsFormScope<Servers>; taken: string[]; onClose: () => void}): React.ReactNode {
  const {busy, message, setMessage, write} = useWrite(scope, t);
  const [name, setName] = React.useState(''), [url, setUrl] = React.useState(''), [timeout, setTimeoutMs] = React.useState(String(DEFAULT_TIMEOUT_MS));
  const [headers, setHeaders] = React.useState<{key: string; value: string}[]>([]);
  const github = () => {
    setName(current => current || 'github'); setUrl('https://api.githubcopilot.com/mcp/');
    setHeaders([{key: 'Authorization', value: 'Bearer '}, {key: 'X-MCP-Toolsets', value: 'repos,pull_requests,issues'}]);
  };
  const save = async () => {
    if (!NAME.test(name.trim()) || taken.includes(name.trim())) {setMessage({error: true, text: t('invalidName')}); return;}
    if (headers.some(item => item.key.trim() && !HEADER.test(item.key.trim()))) {setMessage({error: true, text: t('invalidHeader')}); return;}
    const value: Server = {name: name.trim(), url: url.trim(), toolCallTimeoutMs: Math.round(Number(timeout) || DEFAULT_TIMEOUT_MS), enabled: true,
      headers: Object.fromEntries(headers.filter(item => item.key.trim()).map(item => [item.key.trim(), item.value]))};
    if (await write([{op: 'set', path: ['servers', String(taken.length)], value}])) onClose();
  };
  return h('section', {'aria-label': t('add'), style: card},
    h('div', {style: {...row, justifyContent: 'space-between'}}, h('strong', null, t('add')), h(Button, {variant: 'outline', size: 'sm', disabled: busy, onClick: github}, t('github'))),
    h('p', {style: muted}, t('githubHint')),
    h(Labeled, {label: t('name'), hint: t('nameHint')}, h(Input, {value: name, spellCheck: false, onChange: event => setName(event.target.value)})),
    h(Labeled, {label: t('url'), hint: t('urlHint')}, h(Input, {value: url, spellCheck: false, placeholder: 'https://', onChange: event => setUrl(event.target.value)})),
    h(Labeled, {label: t('timeout')}, h(Input, {type: 'number', min: 1000, max: 600000, value: timeout, onChange: event => setTimeoutMs(event.target.value)})),
    h('div', {style: {display: 'grid', gap: 8}}, h('span', {style: {fontWeight: 500, fontSize: 13}}, t('headers')), h('span', {style: muted}, t('headersHint')),
      h(HeaderRows, {t, rows: headers, setRows: setHeaders, disabled: busy})),
    h('div', {style: row}, h(Button, {variant: 'primary', size: 'sm', disabled: busy, onClick: () => {void save();}}, t(busy ? 'saving' : 'save')),
      h(Button, {variant: 'outline', size: 'sm', disabled: busy, onClick: onClose}, t('cancel'))),
    h(Notice, {message}));
}
