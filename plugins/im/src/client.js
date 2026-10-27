import React from 'react';
import {qrSvg} from './qr.js';
import {zh, en} from './client-locales.js';
import {WeixinLogoGlyph, FeishuLogoGlyph, QqLogoGlyph} from './channel-logos.js';
import {installSessionChannelLogos} from './session-channel-logos.js';
import './client.css';

const h = React.createElement;
const NS = 'weft.im', PACKAGE = '@weft/dsh-im';
const channels = ['weixin', 'feishu', 'qq'];
const logos = {weixin: WeixinLogoGlyph, feishu: FeishuLogoGlyph, qq: QqLogoGlyph};
const namespace = channel => `installed/${PACKAGE}/im-${channel}`;
const secretFields = ['appSecret', 'verificationToken', 'encryptKey'];
const keyField = channel => channel === 'weixin' ? 'loginKey' : 'managementKey';

/** The deployment mount identifies the tenant and the selected environment. */
export function hookBase(base = document.baseURI) {
  const url = new URL(base);
  const match = /^\/v1\/tenants\/([^/]+)\/environments\/([^/]+)\/native\//.exec(url.pathname);
  if (!match) throw new Error('IM configuration requires a Weft environment');
  return `${url.origin}/v1/plugin-hooks/${match[1]}/${match[2]}/${encodeURIComponent(PACKAGE)}`;
}

export const name = 'dsh-im-settings';
export const inject = ['slots', 'locale', 'configForms'];
export function apply(ctx) {
  ctx.effect(() => installSessionChannelLogos(), 'dsh-im Session channel logos');
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'dsh-im dictionaries');
  const forms = Object.fromEntries(channels.map(channel => [channel, {
    scope: ctx.configForms.get(namespace(channel)),
    hasSecret: field => ctx.configForms.describe().getSnapshot().view?.namespaces.find(row => row.ns === namespace(channel))?.secrets
      ?.some(secret => secret.path.length === 1 && secret.path[0] === field && secret.set) === true,
  }]));
  const core = ctx.configForms.get(`installed/${PACKAGE}/im-core`);
  ctx.slots.inject('settings.section', () => ctx.slots.register({name: 'settings.section', id: 'weft-im', order: 21,
    label: () => ctx.locale.bind(NS)('title'), locale: NS}, ({t}) => h(ImSettings, {forms, core, t})));
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({name: 'plugins.detail.section', id: 'weft-im', order: 20, locale: NS},
    ({subject, t}) => subject.kind === 'bundle' && subject.pkg?.name === PACKAGE ? h(ImSettings, {forms, core, t}) : null));
}

function Action({children, kind = 'secondary', className = '', ...props}) {
  return h('button', {...props, type: 'button', className: `im-button ${className}`, 'data-kind': kind}, children);
}
function Icon({kind, size = 16}) {
  const paths = {qr: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v6h-2zM15 19h2v2h-2z',
    key: 'M10 12a4 4 0 1 1-4-4 4 4 0 0 1 4 4Zm0 0h11m-3 0v3m-4-3v3',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
    back: 'm14 5-7 7 7 7', refresh: 'M20 7V3m0 0h-4m4 0-3 3a8 8 0 1 0 3 8'};
  return h('svg', {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true}, h('path', {d: paths[kind] ?? paths.settings}));
}
function Logo({channel, large = false}) {
  return h('span', {className: `dim-logo im-logo-${channel}${large ? ' im-logo-large' : ''}`, 'aria-hidden': true}, h(logos[channel]));
}
function Notice({error, children}) {return children ? h('p', {className: error ? 'im-notice im-error' : 'im-notice', role: error ? 'alert' : 'status'}, children) : null;}
function Field({label, value, onChange, secret, ...props}) {
  return h('label', {className: 'dim-credentialField'}, h('span', null, label),
    h('input', {...props, type: secret ? 'password' : 'text', autoComplete: 'off', value: value ?? '', onChange: onChange ? event => onChange(event.target.value) : undefined}));
}

/** Atomic, revision-fenced edits retain drafts on a refused write and never replay redacted secrets. */
function useForm(scope, t) {
  const snapshot = React.useSyncExternalStore(React.useCallback(fn => scope.subscribe(fn), [scope]), React.useCallback(() => scope.getSnapshot(), [scope]));
  const [draft, setDraft] = React.useState({}), revision = React.useRef();
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(), [message, setMessage] = React.useState();
  const lock = React.useRef(false);
  const edit = (field, value) => {revision.current ??= snapshot.revision; setDraft(previous => ({...previous, [field]: value})); setMessage(undefined);};
  const discard = () => {setDraft({}); revision.current = undefined; setError(undefined); setMessage(undefined);};
  const commit = async (patch = {}, includeDraft = true) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(undefined); setMessage(undefined);
    try {
      const values = {...(includeDraft ? draft : {}), ...patch};
      if (values.allowedSenders) values.allowedSenders = [...new Set(values.allowedSenders.map(value => value.trim()).filter(Boolean))];
      if (includeDraft) for (const field of secretFields) if (values[field] === '') delete values[field];
      const ops = Object.entries(values).map(([field, value]) => ({op: 'set', path: [field], value}));
      if (ops.length && !await scope.mutate(ops, includeDraft ? revision.current ?? snapshot.revision : scope.getSnapshot().revision)) throw new Error(t('failed'));
      if (includeDraft) {setDraft({}); revision.current = undefined; setMessage(t('saved'));}
      return true;
    } catch (reason) {setError(reason instanceof Error ? reason.message : String(reason)); return false;}
    finally {lock.current = false; setBusy(false);}
  };
  return {snapshot, draft, value: {...snapshot.value, ...draft}, dirty: Object.keys(draft).length > 0, busy, error, message, edit, discard, commit, setError};
}

function ImSettings({forms, core, t}) {
  const [selected, setSelected] = React.useState('weixin');
  const id = React.useId();
  const select = channel => setSelected(channel);
  const navigate = event => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = channels.indexOf(selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? channels.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + channels.length) % channels.length;
    select(channels[next]); document.getElementById(`${id}-tab-${channels[next]}`)?.focus();
  };
  return h('section', {className: 'weft-im dim-page', 'aria-label': t('title')},
    h('header', {className: 'dim-title'},
      h('div', {className: 'dim-brand'}, h('div', {className: 'dim-brandHeading'}, h('strong', {className: 'dim-brandName'}, 'DSH-IM'), h('span', {className: 'dim-brandVersion'}, 'v0.3.1')), h('p', null, t('tagline'))),
      h('div', {className: 'im-title-actions'},
        h('a', {href: 'https://github.com/xmanrui/dsh-im', target: '_blank', rel: 'noopener noreferrer', className: 'im-help'}, t('help')),
        h(Action, {'aria-label': t('generalSettings'), 'aria-pressed': selected === 'general', onClick: () => setSelected(selected === 'general' ? 'weixin' : 'general')}, h(Icon, {kind: 'settings'})))),
    h('div', {className: 'dim-layout'},
      h('nav', {className: 'dim-rail', role: 'tablist', 'aria-label': t('navigation'), 'aria-orientation': 'vertical', onKeyDown: navigate}, channels.map(channel => h('button', {
        key: channel, type: 'button', role: 'tab', className: 'dim-channel', id: `${id}-tab-${channel}`, tabIndex: selected === channel ? 0 : -1,
        'aria-selected': selected === channel, 'aria-controls': `${id}-panel-${channel}`, onClick: () => select(channel)},
      h(Logo, {channel}), h('span', {className: 'dim-channelCopy'}, h('strong', null, t(channel)))))),
      h('div', {className: 'dim-divider', 'aria-hidden': true}),
      h('div', {className: 'dim-panel'},
        channels.map(channel => h('div', {key: channel, id: `${id}-panel-${channel}`, role: 'tabpanel', hidden: selected !== channel, 'aria-labelledby': `${id}-tab-${channel}`},
          h(Channel, {channel, editor: forms[channel], active: selected === channel, t}))),
        selected === 'general' ? h(GeneralSettings, {scope: core, t}) : null)));
}

async function channelRequest(base, channel, key, path, method, t, signal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`${base}/${channel}/${path}`, {method, headers: {authorization: `Bearer ${key}`}, cache: 'no-store', ...(signal ? {signal} : {})});
    if ([403, 404, 503].includes(response.status) && attempt < 8) {
      await new Promise((resolve, reject) => {
        const done = () => {signal?.removeEventListener('abort', stop); resolve();};
        const timer = setTimeout(done, 500);
        const stop = () => {clearTimeout(timer); reject(signal.reason);};
        signal?.addEventListener('abort', stop, {once: true});
      });
      continue;
    }
    if (!response.ok) throw new Error(t(response.status === 502 && channel !== 'weixin' ? 'credentialsFailed' : 'routeFailed'));
    return response.json();
  }
}

function Channel({channel, editor, active, t}) {
  const form = useForm(editor.scope, t);
  const [view, setView] = React.useState('list'), [settingsTab, setSettingsTab] = React.useState('general');
  const [access, setAccess] = React.useState(), [status, setStatus] = React.useState(), [checkedAt, setCheckedAt] = React.useState();
  const [working, setWorking] = React.useState(false), [removing, setRemoving] = React.useState(false), [copied, setCopied] = React.useState(false);
  const task = React.useRef(), locked = React.useRef(false);
  const [generation, setGeneration] = React.useState(0);
  const id = React.useId();
  const {snapshot, value, draft} = form;
  const base = hookBase();
  const configured = snapshot.value?.accountConfigured ?? (channel === 'weixin' ? !!snapshot.value?.enabled : !!snapshot.value?.appId);
  const enabled = !!snapshot.value?.enabled;
  const busy = working || form.busy, disabled = busy || !snapshot.writable || snapshot.status !== 'ready';
  const state = !enabled ? 'disabled' : status?.state ?? 'unchecked';
  const connected = state === 'online';
  const reset = () => {form.discard(); setView('list');};
  React.useEffect(() => () => task.current?.abort(), []);
  // Polling belongs to the selected panel; switching channels preserves its draft and QR capability.
  React.useEffect(() => {
    if (!active || !access || !enabled || working || channel !== 'weixin') return;
    const abort = new AbortController(); let timer;
    const read = async () => {
      try {
        const next = await channelRequest(base, channel, access, 'status', 'GET', t, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next); setCheckedAt(Date.now());
        if (next.state === 'online') setView(previous => previous === 'scan' ? 'list' : previous);
        if (['online', 'login', 'ready'].includes(next.state)) timer = setTimeout(read, next.state === 'login' ? 2000 : 10000);
      } catch (reason) {if (!abort.signal.aborted) form.setError(reason.message);}
    };
    timer = setTimeout(read, 2000);
    return () => {abort.abort(); clearTimeout(timer);};
  }, [access, active, enabled, working, generation, base, channel, t]);

  const perform = async operation => {
    if (locked.current) return;
    locked.current = true; setWorking(true); form.setError(undefined);
    task.current?.abort(); const abort = new AbortController(); task.current = abort;
    try {
      let key = access;
      if (!key || operation === 'scan' && !enabled) {
        key = crypto.randomUUID() + crypto.randomUUID();
        if (!await form.commit({[keyField(channel)]: key, ...(operation === 'scan' ? {enabled: true, accountConfigured: true} : {})}, false)) return;
      }
      const next = await channelRequest(base, channel, key, operation === 'scan' ? 'login?reset=1' : operation === 'remove' ? 'disconnect' : 'status', operation === 'check' ? 'GET' : 'POST', t, abort.signal);
      if (abort.signal.aborted) return;
      if (operation === 'remove') {
        setAccess(undefined); setStatus(undefined);
        if (await form.commit({enabled: false, accountConfigured: false, displayName: '', [keyField(channel)]: '', ...(channel === 'weixin' ? {} : {appId: '', appSecret: '', ...(channel === 'feishu' ? {verificationToken: '', encryptKey: ''} : {})})}, false)) {setRemoving(false); reset();}
        return;
      }
      setAccess(key); setStatus(next); setCheckedAt(Date.now()); setGeneration(value => value + 1);
      if (operation === 'scan') setView(next.state === 'online' ? 'list' : 'scan');
    } catch (reason) {if (!abort.signal.aborted) {if (operation === 'check') setStatus({state: 'error'}); form.setError(reason instanceof Error ? reason.message : String(reason));}}
    finally {locked.current = false; setWorking(false);}
  };
  const bind = async event => {
    event.preventDefault();
    if (!value.appId?.trim() || !value.appSecret && !(configured && editor.hasSecret('appSecret')) || channel === 'feishu' && !value.verificationToken && !(configured && editor.hasSecret('verificationToken'))) {form.setError(t('missing')); return;}
    if (await form.commit({enabled: true, accountConfigured: true})) {setStatus(undefined); setView('list');}
  };
  const saveSettings = async event => {event.preventDefault(); if (await form.commit()) setStatus(undefined);};
  const field = (name, secret = false) => h(Field, {key: name, label: t(name), disabled, secret, value: secret ? draft[name] ?? '' : value[name] ?? '', placeholder: secret ? t('secretHint') : '', onChange: text => form.edit(name, text)});
  const scan = h(Action, {kind: 'primary', disabled: disabled || form.dirty, onClick: () => void perform('scan')}, h(Icon, {kind: 'qr'}), t(configured ? 'rescan' : 'scan'));
  const manual = h(Action, {disabled, 'aria-pressed': view === 'manual', onClick: () => view === 'manual' ? reset() : setView('manual')}, h(Icon, {kind: 'key'}), t(view === 'manual' ? 'hideCredentials' : 'manual'));
  if (snapshot.status !== 'ready') return h(Notice, null, t('unavailable'));
  return h('div', {className: 'dim-channelPage'},
    h('div', {className: 'im-channel-toolbar'}, h('div', {className: 'im-bind-actions'}, channel === 'weixin' ? scan : manual),
      configured ? h('span', {className: 'im-count'}, t(connected ? 'oneOnline' : 'oneConfigured')) : null),
    view === 'manual' ? h('section', {className: 'dim-surfaceCard dim-credentialPanel', 'aria-label': t('manualTitle')},
      h('h3', {className: 'dim-credentialTitle'}, `${t('manualTitle')} · ${t(channel)}`), h('p', {className: 'im-description'}, t(`${channel}Guide`)),
      h('form', {className: 'dim-credentialForm', onSubmit: bind},
        channel === 'feishu' ? h('label', {className: 'dim-credentialField im-full'}, t('domain'), h('select', {disabled, value: value.domain || 'feishu', onChange: event => form.edit('domain', event.target.value)}, h('option', {value: 'feishu'}, 'Feishu'), h('option', {value: 'lark'}, 'Lark'))) : null,
        field('appId'), field('appSecret', true), channel === 'feishu' ? [field('verificationToken', true), field('encryptKey', true)] : null,
        h('div', {className: 'im-full'}, h(Callback, {url: `${base}/${channel}`, copied, setCopied, t, onError: form.setError})),
        h('div', {className: 'dim-credentialActions im-actions'}, h('button', {type: 'submit', className: 'im-button', 'data-kind': 'primary', disabled}, t(busy ? 'saving' : 'bind')), h(Action, {disabled, onClick: reset}, t('cancel'))))) : null,
    view === 'scan' ? h(QrPanel, {status, busy, channel, t, onRefresh: () => void perform('scan'), onClose: () => setView('list')}) : null,
    view === 'settings' ? h('section', {className: 'im-settings', 'aria-label': t('moreSettings')},
      h('div', {className: 'dim-deliveryHeader'}, h(Action, {onClick: reset, disabled}, h(Icon, {kind: 'back'}), t('back')), h('strong', null, value.displayName || t(channel))),
      h('div', {className: 'dim-botSettingsTabsBar'}, h('div', {className: 'dim-botSettingsTabsList', role: 'tablist', 'aria-label': t('moreSettings')}, ['general', 'access'].map(tab => h('button', {
        key: tab, type: 'button', role: 'tab', className: 'dim-botSettingsTab', 'aria-selected': settingsTab === tab, 'aria-controls': `${id}-${tab}`, id: `${id}-tab-${tab}`, onClick: () => setSettingsTab(tab)}, t(tab))))),
      h('form', {className: 'dim-botSettingsTabPanel', role: 'tabpanel', id: `${id}-${settingsTab}`, 'aria-labelledby': `${id}-tab-${settingsTab}`, onSubmit: saveSettings},
        settingsTab === 'general' ? [field('displayName'), field('workspace'), field('agentPreset'),
          h('p', {key: 'new', className: 'im-description'}, t('newSessionsHint')),
          h('label', {key: 'chars', className: 'dim-credentialField'}, t('maxChars'), h('input', {type: 'number', min: 200, max: channel === 'feishu' ? 10000 : channel === 'qq' ? 5000 : 4000, disabled, value: value.maxChars, onChange: event => form.edit('maxChars', Number(event.target.value))})),
          channel !== 'weixin' ? h('div', {key: 'callback'}, h(Callback, {url: `${base}/${channel}`, copied, setCopied, t, onError: form.setError})) : null] : [
          h('label', {key: 'senders', className: 'dim-credentialField'}, t('allowedSenders'), h('textarea', {rows: 5, disabled, value: (value.allowedSenders ?? []).join('\n'), onChange: event => form.edit('allowedSenders', event.target.value.split('\n'))})),
          h('p', {key: 'hint', className: 'im-description'}, t('sendersHint'))],
        h('div', {className: 'im-actions'}, h('button', {type: 'submit', className: 'im-button', 'data-kind': 'primary', disabled: disabled || !form.dirty}, t(busy ? 'saving' : 'save')), h(Action, {disabled: disabled || !form.dirty, onClick: form.discard}, t('discard'))))) : null,
    view === 'list' && !configured ? h('section', {className: 'dim-surfaceCard dim-surfaceBody dim-emptyView'},
      h('div', {className: 'dim-emptyCopy'}, h('div', {className: 'dim-stateLabel'}, h('span', {className: 'dim-stateDot'}), t('notConnected')),
        h('h3', null, t(channel === 'weixin' ? 'emptyScanTitle' : 'emptyManualTitle')), h('p', null, t(`${channel}Guide`)),
        h('div', {className: 'dim-viewActions'}, channel === 'weixin' ? scan : manual)), h('div', {className: 'dim-emptyBrand'}, h(Logo, {channel, large: true}))) : null,
    view === 'list' && configured ? h('section', {className: 'dim-listSection', 'aria-label': t('bots')},
      h('div', {className: 'dim-listHeading'}, h('h3', null, t('bots')), h('span', {className: 'im-transport', title: t(channel === 'weixin' ? 'weixinTransport' : 'callbackTransport')}, t(channel === 'weixin' ? 'weixinTransport' : 'callbackTransport'))),
      h('article', {className: 'dim-botCard', 'aria-label': value.displayName || t(channel)}, h('div', {className: 'dim-botCardBody'},
        h('div', {className: 'dim-botCardTop'}, h('div', {className: 'dim-botIdentity'}, h(Logo, {channel}), h('div', {className: 'dim-botName'}, h('h3', null, value.displayName || t(channel)), h('p', null, status?.botId || snapshot.value?.appId || t('weixinAccount')))),
          h('div', {className: 'dim-botHealthGroup'}, h('div', {className: 'dim-botHealth', role: 'status'}, h('span', {className: 'dim-healthDot', 'data-tone': connected || state === 'ready' ? 'success' : state === 'expired' ? 'error' : 'warning'}), t(state)),
            h('div', {className: 'dim-lastChecked'}, t('lastChecked'), checkedAt ? new Date(checkedAt).toLocaleTimeString() : '—'))),
        h('div', {className: 'im-bot-options'},
          h('div', {className: 'dim-workspace'}, h('div', {className: 'dim-workspaceHeader'}, h('span', null, t('workspace'))), h('code', {className: 'dim-workspacePath'}, snapshot.value.workspace || '/workspace')),
          h('div', {className: 'dim-workspace'}, h('div', {className: 'dim-workspaceHeader'}, h('span', null, t('agentPreset'))), h('span', {className: 'dim-workspacePath'}, snapshot.value.agentPreset || t('followDefault')))),
        h('div', {className: 'im-card-footer'}, h(Action, {className: 'dim-botSettingsButton', disabled, onClick: () => setView('settings')}, h(Icon, {kind: 'settings'}), t('moreSettings')),
          h('div', {className: 'im-actions'}, h(Action, {disabled, onClick: () => void perform('check')}, h(Icon, {kind: 'refresh'}), t(working ? 'checking' : 'check')),
            h(Action, {disabled, onClick: async () => {if (await form.commit({enabled: !enabled}, false)) {setStatus(undefined); setAccess(undefined);}}}, t(enabled ? 'pause' : 'resume')),
            h(Action, {kind: 'danger', disabled, onClick: () => setRemoving(true)}, t('remove'))))),
        removing ? h('div', {className: 'dim-confirm', role: 'alertdialog', 'aria-label': t('removeTitle')}, h('strong', null, t('removeTitle')), h('p', null, t('removeHint')), h('div', {className: 'dim-viewActions'}, h(Action, {disabled, onClick: () => setRemoving(false)}, t('keep')), h(Action, {kind: 'danger', disabled, onClick: () => void perform('remove')}, t('confirmRemove')))) : null)) : null,
    h(Notice, {error: true}, form.error || status?.error), h(Notice, null, form.message));
}

function Callback({url, copied, setCopied, t, onError}) {
  return h('div', {className: 'im-callback'}, h(Field, {label: t('callback'), value: url, readOnly: true}),
    h(Action, {onClick: async () => {try {await navigator.clipboard.writeText(url); setCopied(true);} catch {onError(t('copyFailed'));}}}, t(copied ? 'copied' : 'copy')));
}
function QrPanel({status, busy, channel, t, onRefresh, onClose}) {
  let svg, error;
  try {if (status?.state === 'login' && status.qrcodeUrl) svg = qrSvg(status.qrcodeUrl);} catch (reason) {error = String(reason.message);}
  const expired = status && status.state !== 'login' && status.state !== 'online';
  return h('section', {className: 'dim-surfaceCard dim-surfaceBody', 'aria-label': t('scanPanel')},
    h('div', {className: 'dim-qrLayout'},
      h('div', {className: 'dim-qrColumn'}, h('div', {className: 'dim-qrFrame'}, svg ? h('div', {className: 'im-qr-svg', role: 'img', 'aria-label': t('qrImage'), dangerouslySetInnerHTML: {__html: svg}}) : h(Icon, {kind: 'qr', size: 58}),
        expired ? h('div', {className: 'dim-qrExpired', role: 'status'}, t('qrExpired')) : null)),
      h('div', {className: 'dim-qrCopy'}, h('div', {className: 'dim-stateLabel'}, h('span', {className: 'dim-stateDot', 'data-tone': expired ? 'warning' : undefined}), t(expired ? 'expired' : 'waiting')),
        h('h3', null, t('scanTitle')), h('p', null, t(`${channel}Guide`)), h('ol', {className: 'dim-steps'}, ['scanStep1', 'scanStep2', 'scanStep3'].map(step => h('li', {key: step}, t(step)))),
        h('div', {className: 'dim-viewActions'}, h(Action, {kind: 'primary', disabled: busy, onClick: onRefresh}, t('refreshQr')), h(Action, {disabled: busy, onClick: onClose}, t('back'))))),
    h(Notice, {error: true}, error));
}
function GeneralSettings({scope, t}) {
  const form = useForm(scope, t);
  return h('section', {className: 'im-settings', 'aria-label': t('generalSettings')}, h('h3', null, t('generalSettings')),
    h('form', {className: 'dim-botSettingsTabPanel', onSubmit: async event => {event.preventDefault(); await form.commit();}},
      h(Field, {label: t('defaultPreset'), value: form.value.agentPreset || '', disabled: form.busy, onChange: value => form.edit('agentPreset', value)}),
      h('label', {className: 'im-checkbox'}, h('input', {type: 'checkbox', disabled: form.busy, checked: form.value.titlePrefix !== false, onChange: event => form.edit('titlePrefix', event.target.checked)}), t('titlePrefix')),
      h('p', {className: 'im-description'}, t('newSessionsHint')), h('button', {type: 'submit', className: 'im-button', 'data-kind': 'primary', disabled: form.busy || !form.dirty}, t('save'))),
    h('details', {className: 'im-about'}, h('summary', null, t('setupHelp')), h('p', {className: 'im-description'}, t('permissions')), h('p', {className: 'im-description'}, t('singleBotHint'))),
    h(Notice, {error: true}, form.error), h(Notice, null, form.message));
}
