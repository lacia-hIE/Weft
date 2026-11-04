/** @jsxRuntime automatic */
/** Connection list, connector picker and a focused editor for each Source identity. */
import {useEffect, useState} from 'react'
import type {SourceType} from '../sources/types.ts'
import type {FieldSpec} from '../sources/kind.ts'
import {usePoll, type SourceView} from './api.ts'
import {Button, DisclosureRow, Dot, Icon, Input, Modal, Switch, Tag} from './controls.tsx'
import {GithubIntegration, type DeploymentForm} from './deployment.tsx'
import {SaveBar} from './draft.tsx'
import {usePanel, usePanelData} from './provider.tsx'
import {settingsRoute} from './route.ts'
import {ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings} from './settings-kit.tsx'
import {Select} from './select.tsx'
import {SourceCredentials} from './source-credentials.tsx'
import {connectionType, connectionTypes} from './source-types.ts'
import {sourceMark} from './marks.ts'
import {localized} from './text.ts'
import {ConfirmButton, Hint, LoadState, SetupMessage} from './widgets.tsx'

function SourceEditor({source, form, onBack, onDelete}: {source: SourceView; form?: DeploymentForm; onBack(): void; onDelete(source: SourceView): Promise<void>}) {
  const {t, call, navigate} = usePanel(), {reload} = useSettings()
  const [advanced, setAdvanced] = useState(false)
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision), value = draft.value
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={source.value.config[spec.key]}
    labels={source.labels} fact={spec.type === 'fact' || JSON.stringify(value.config[spec.key]) === JSON.stringify(source.value.config[spec.key]) ? source.facts[spec.key] : undefined} refreshLabels={async () => {const result = await call('POST sources/:id/labels', {id: source.id});await reload();return result.added}}
    onChange={next => draft.edit({...value, config: {...value.config, [spec.key]: next}})}/>
  return <div className="dt-form" id={`dt-source-${source.id}`}>
    <div className="dt-connection-detail-head">
      <Button icon={<Icon name="chevron-left"/>} onClick={onBack}>{t('sourceBack')}</Button>
      <div className="dt-row-buttons">
        {source.policy && <Button variant="outline" onClick={() => navigate(settingsRoute('eval', {source: source.id}))}>{t('sourceAssessment')}</Button>}
        {source.id !== 'request' && <ConfirmButton label={t('sourceDelete')} title={t('sourceDelete')} icon="trash"
          message={t('sourceDeleteHint', {name: localized(t, source.title)})} onConfirm={() => onDelete(source)}/>}
      </div>
    </div>
    <form className="dt-card dt-form" onSubmit={event => {void draft.submit(event)}}>
      <Fields disabled={draft.busy || !!source.value.archived}>
        <div><Tag>{connectionType(t, source.kind)}</Tag><h3 className="dt-section-title">{localized(t, source.title)}</h3></div>
        <Hint>{localized(t, source.description)}</Hint>
        {source.id !== 'request' && <Field label={t('sourceInstanceName')}><Input maxLength={80} value={value.name || ''} onChange={event => draft.edit({...value, name: event.target.value})}/></Field>}
        <Switch checked={value.enabled} onChange={enabled => draft.edit({...value, enabled})} label={t('sourceEnable', {name: localized(t, source.title)})}/>
        {source.problem && <p className="dt-hint"><SetupMessage problem={source.problem} lead/></p>}
        {source.fields.filter(spec => !spec.advanced).map(field)}
        {source.fields.some(spec => spec.advanced) && <DisclosureRow icon={<Icon name="settings"/>} title={t('advanced')} open={advanced} onToggle={() => setAdvanced(!advanced)}>
          <div className="dt-disclosure-body">{source.fields.filter(spec => spec.advanced).map(field)}</div>
        </DisclosureRow>}
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard}/>
    </form>
    {['github-webhook', 'gitlab', 'feed'].includes(source.kind) && !source.value.archived && <div className="dt-card"><SourceCredentials id={source.id} kind={source.kind} form={form} config={value.config}/></div>}
    {source.id === 'github' && !source.value.archived && <GithubIntegration form={form}/>}
  </div>
}

function AddSources({open, onClose, onAdded, sources}: {open: boolean; onClose(): void; onAdded(id: string): Promise<void>; sources: SourceView[]}) {
  const {t, call} = usePanel()
  const [kind, setKind] = useState<SourceType>(), [name, setName] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const bots = usePoll(() => open ? call('GET source-bots') : Promise.resolve([]), [open])
  const im = kind && ['feishu', 'weixin', 'qq', 'email'].includes(kind)
  const available = bots.data?.filter(bot => bot.kind === kind && !sources.some(source => !source.value.archived && source.value.config.bot === bot.bot && source.kind === kind)) ?? []
  const choose = (next: SourceType) => {setKind(next);setName('');setSelected([]);setError('')}
  const add = async () => {
    if (!kind) return
    setBusy(true);setError('')
    let first: string | undefined
    try {
      const connections = im ? available.filter(bot => selected.includes(bot.bot)) : [undefined]
      for (const bot of connections) {
        const label = bot ? bot.name || bot.bot : connectionType(t, kind)
        const title = name.trim() ? connections.length > 1 ? `${name.trim()} · ${label}` : name.trim() : label
        const result = await call('POST sources', {body: {kind, name: title.slice(0, 80), ...(bot ? {config: {bot: bot.bot}} : {})}})
        first ??= result.id
      }
      if (first) {await onAdded(first);onClose()}
    } catch (failure) {setError(String(failure));if (first) await onAdded(first)}
    finally {setBusy(false)}
  }
  return <Modal open={open} onClose={() => {if (!busy) onClose()}} title={t('sourceAdd')} closeLabel={t('close')} className="dt-connector-modal"
    footer={kind ? <><Button disabled={busy} onClick={() => setKind(undefined)}>{t('sourceChooseType')}</Button><Button variant="primary" disabled={busy || !!im && !selected.length} onClick={() => {void add()}}>{t('sourceAdd')}</Button></> : undefined}>
    {!kind ? <div className="dt-connector-catalog">{connectionTypes.map(type => <button type="button" key={type.id} className="dt-connector-app" aria-label={connectionType(t, type.id)} onClick={() => choose(type.id)}>
      <span className="dt-connection-mark">{type.mark}</span><span><strong>{connectionType(t, type.id)}</strong><small>{t('sourceMultiple')}</small></span><Icon name="chevron-right"/>
    </button>)}</div> : <div className="dt-form">
      <div><Tag>{connectionType(t, kind)}</Tag></div>
      <Field label={t('sourceInstanceName')}><Input value={name} maxLength={80} placeholder={connectionType(t, kind)} disabled={busy} onChange={event => setName(event.target.value)}/></Field>
      {im && <div className="dt-form">
        <span>{t('sourceChooseConnections')}</span>
        <LoadState loading={!bots.data} error={bots.error}/>
        {available.map(bot => <label className="dt-connector-account" key={bot.bot}><input type="checkbox" disabled={busy} checked={selected.includes(bot.bot)} onChange={event => setSelected(event.target.checked ? [...selected, bot.bot] : selected.filter(id => id !== bot.bot))}/><span>{bot.name || bot.bot}<small>{bot.bot}</small></span></label>)}
        {bots.data && !available.length && <Hint>{t('sourceNoBots')}</Hint>}
        <div><Button disabled={busy} onClick={() => {void bots.reload()}}>{t('sourceRefresh')}</Button></div>
      </div>}
      {error && <p role="alert" className="dt-error">{error}</p>}
    </div>}
  </Modal>
}

export function SourceSettings({focus, form}: {focus?: string; form?: DeploymentForm}) {
  const {settings: {sources}, reload} = useSettings(), {t, call, notify, restart} = usePanel(), {state} = usePanelData()
  const [selected, setSelected] = useState<string | undefined>(focus), [adding, setAdding] = useState(false), [query, setQuery] = useState(''), [type, setType] = useState(''), [status, setStatus] = useState('')
  const [busy, setBusy] = useState<string>()
  useEffect(() => {setSelected(focus)}, [focus])
  const connected = sources.filter(source => !source.value.archived && (source.value.kind || source.configured || source.id === 'request' || source.id === 'github' && (state?.setup.secrets.githubToken || state?.setup.secrets.webhookSecret)))
  const matches = connected.filter(source => (!type || (source.kind === 'github' ? 'github-webhook' : source.kind) === type) && (!status || String(source.value.enabled) === status) && `${localized(t, source.title)} ${connectionType(t, source.kind)} ${source.value.config.repository ?? ''} ${source.value.config.bot ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const current = sources.find(source => source.id === selected)
  const remove = async (source: SourceView) => {
    let removed = false
    try {
      await call('DELETE sources/:id', {id: source.id, body: {revision: source.revision}});removed = true
      const flags = state?.setup.sourceSecrets[source.id], legacy = source.id === 'github' && (state?.setup.secrets.githubToken || state?.setup.secrets.webhookSecret)
      if (legacy || flags && Object.values(flags).some(Boolean)) {
        const snapshot = form?.state
        if (!form || snapshot?.status !== 'ready' || !snapshot.writable) throw new Error(t('deploymentRefused'))
        const ops = source.id === 'github' ? [{op: 'set' as const, path: ['githubToken'], value: ''}, {op: 'set' as const, path: ['webhookSecret'], value: ''}]
          : (['webhook', 'token', 'feed'] as const).map(name => ({op: 'set' as const, path: ['sourceSecrets', `${source.id}-${name}`], value: ''}))
        if (!await form.mutate(ops, snapshot.revision)) throw new Error(t('deploymentRefused'))
        restart()
      }
      await reload();setSelected(undefined);notify(t('saved'))
    } catch (failure) {throw new Error(`${removed ? `${t('sourceDeleteCleanup')} ` : ''}${String(failure)}`)}
  }
  const toggle = async (source: SourceView, enabled: boolean) => {
    setBusy(source.id)
    try {await call('PUT settings/:block', {block: `source:${source.id}`, body: {value: {...source.value, enabled}, revision: source.revision}});await reload()}
    catch (failure) {notify(String(failure))}
    finally {setBusy(undefined)}
  }
  return <div className="dt-form">
    {current ? <SourceEditor key={current.id} source={current} form={form} onBack={() => setSelected(undefined)} onDelete={remove}/> : <>
      <div className="dt-connection-heading"><div><h3 className="dt-section-title">{t('sourceConnections')}</h3><Hint>{t('sourceConnectionsHint')}</Hint></div><Button variant="primary" icon={<Icon name="plus"/>} onClick={() => setAdding(true)}>{t('sourceAdd')}</Button></div>
      <div className="dt-connection-filters">
        <Input aria-label={t('sourceSearch')} placeholder={t('sourceSearch')} value={query} onChange={event => setQuery(event.target.value)}/>
        <Field label={t('sourceType')}><Select value={type} placeholder={t('sourceAllTypes')} options={[{value: '', label: t('sourceAllTypes')}, ...connectionTypes.map(row => ({value: row.id, label: connectionType(t, row.id)}))]} onChange={setType}/></Field>
        <Field label={t('sourceStatus')}><Select value={status} placeholder={t('sourceAllStates')} options={[{value: '', label: t('sourceAllStates')}, {value: 'true', label: t('sourceActive')}, {value: 'false', label: t('sourceInactive')}]} onChange={setStatus}/></Field>
      </div>
      <ul className="dt-connections" aria-label={t('sourceConnections')}>
        {matches.map(source => {const mark = sourceMark(t, source.state);return <li className="dt-connection-row" data-source-id={source.id} key={source.id}>
          <span className="dt-connection-mark">{connectionTypes.find(type => type.id === source.kind)?.mark ?? (source.id === 'github' ? 'GH' : 'DSH')}</span>
          <button type="button" className="dt-connection-name" onClick={() => setSelected(source.id)}><strong>{localized(t, source.title)}</strong><small>{connectionType(t, source.kind)}{source.value.config.repository ? ` · ${source.value.config.repository}` : source.value.config.bot ? ` · ${source.labels[String(source.value.config.bot)] ?? source.value.config.bot}` : ''}</small></button>
          <span className="dt-connection-status"><Dot state={mark.dot}/>{mark.label}</span>
          <Switch checked={source.value.enabled} disabled={busy === source.id} label={t('sourceEnable', {name: localized(t, source.title)})} onChange={enabled => {void toggle(source, enabled)}}/>
          <Button size="sm" variant="outline" aria-label={`${t('sourceEdit')} ${localized(t, source.title)}`} onClick={() => setSelected(source.id)}>{t('sourceEdit')}</Button>
          {source.id !== 'request' && <ConfirmButton label={t('sourceDeleteNamed', {name: localized(t, source.title)})} title={t('sourceDelete')} message={t('sourceDeleteHint', {name: localized(t, source.title)})} icon="trash" onConfirm={() => remove(source)}/>}
        </li>})}
      </ul>
      {!matches.length && <div className="dt-connection-empty"><Icon name="plus" size={24}/><p>{t(connected.length ? 'sourceNoMatches' : 'sourceEmpty')}</p></div>}
      {!connected.some(source => source.id === 'github') && !sources.find(source => source.id === 'github')?.value.archived && <div><Button size="sm" onClick={() => setSelected('github')}>{t('sourceLegacy')}</Button></div>}
    </>}
    <AddSources key={String(adding)} open={adding} sources={sources} onClose={() => setAdding(false)} onAdded={async id => {await reload();setSelected(id)}}/>
    <ConfigHistory blocks={['source:']}/>
  </div>
}
