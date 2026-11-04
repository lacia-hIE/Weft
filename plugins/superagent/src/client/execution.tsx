/** @jsxRuntime automatic */
/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import {attachComputer, connectedComputers} from './computers.ts'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t, call, notify } = usePanel()
  const devices = usePoll(() => call('GET executors'), [])
  const computers = usePoll(connectedComputers, [])
  const [busy, setBusy] = useState(false)
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers) }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const selectComputer = async (selected: string) => {
    if (busy) return
    if (!selected.startsWith('local:')) {edit({executorId: selected || null}); return}
    const computer = computers.data?.find(row => row.id === selected.slice(6))
    if (!computer?.ready) return
    const existing = devices.data?.find(row => row.id === computer.executorId && row.paired)
    if (existing) {edit({executorId: existing.id}); return}
    setBusy(true)
    let created: string | undefined
    try {
      const credential = await call('POST executors', {body: {name: computer.name}})
      created = credential.id
      await attachComputer(computer.id, credential)
      created = undefined
      edit({executorId: credential.id})
      await devices.reload(); await computers.reload()
    } catch (error) {
      if (created) await call('POST executors/:id/revoke', {id: created}).catch(() => {})
      notify(String(error))
    } finally {setBusy(false)}
  }
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { if(busy)event.preventDefault(); else void draft.submit(event) }}>
      <Fields disabled={draft.busy || busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Field label={t('executionComputer')} hint={t('executionComputerHint')}>
            <select className="dt-select" disabled={busy} aria-busy={busy} value={value.executorId ?? ''} onChange={event => {void selectComputer(event.target.value)}}>
              <option value="">{t('cloudExecutor')}</option>
              {devices.data?.map(device => <option key={device.id} value={device.id}>{device.name}{!device.online ? ` · ${t('computerOffline')}` : ''}</option>)}
              {computers.data?.filter(computer => !devices.data?.some(device => device.id === computer.executorId && device.paired)).map(computer => <option key={computer.id} value={`local:${computer.id}`} disabled={!computer.ready}>{computer.name}{!computer.ready ? ` · ${t('computerNeedsSettings')}` : ''}</option>)}
            </select>
          </Field>
          <LoadState error={computers.error} loading={!computers.data} />
          <Hint>{t('connectedComputersHint')}</Hint>
          {!value.executorId && <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>}
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} >
            <Input className="dt-mono" value={value.directory} spellCheck={false} pattern="/workspace.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          {!value.executorId && <Field label={t('executorPermission')} hint={t('executorPermissionHint')}>
            <select className="dt-select" value={value.permission} onChange={event => edit({ permission: event.target.value as typeof value.permission })}>
              <option value="danger-full-access">danger-full-access</option>
              <option value="workspace-write">workspace-write</option>
              <option value="read-only">read-only</option>
            </select>
          </Field>}
        </div>
      </Fields>
      <SaveBar {...draft} busy={draft.busy || busy} onDiscard={draft.discard} />
    </form>
    <Section title={t('executionComputers')} hint={t('executionComputersHint')}>
      <LoadState error={devices.error} loading={!devices.data} />
      {devices.data?.map(device => <div className="dt-row" key={device.id}>
        <div className="dt-row-main"><strong>{device.name}</strong><div className="dt-row-meta">{!device.paired ? t('computerUnpaired') : !device.online ? t('computerOffline') : device.accepting ? t('computerAccepting') : t('computerPaused')}</div></div>
        <ConfirmButton label={t('revokeComputer')} title={t('revokeComputer')} message={t('revokeComputerConfirm')} onConfirm={async () => {
          await call('POST executors/:id/revoke', { id: device.id }); await devices.reload()
        }} />
      </div>)}
      {!computers.data?.length && <Hint>{t('noConnectedComputers')}</Hint>}
    </Section>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
