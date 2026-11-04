/** @jsxRuntime automatic */
import { useRef, useState } from 'react'
import { usePoll } from './api.ts'
import { attachComputer, connectedComputers } from './computers.ts'
import { Button, Modal } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { Hint, LoadState } from './widgets.tsx'

export function NewRequest() {
  const { t, call, navigate } = usePanel(), panel = usePanelData()
  const [open, setOpen] = useState(false), [text, setText] = useState('')
  const [executorId, setExecutorId] = useState<string | null>(null), [projectId, setProjectId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const identity = useRef<{fingerprint: string; id: string} | null>(null)
  const devices = usePoll(() => open ? call('GET executors') : Promise.resolve([]), [open])
  const computers = usePoll(() => open ? connectedComputers() : Promise.resolve([]), [open])
  const select = async (value: string) => {
    setProjectId(null); setError('')
    if (!value.startsWith('local:')) { setExecutorId(value || null); return }
    const computer = computers.data?.find(row => row.id === value.slice(6))
    if (!computer?.ready) return
    setBusy(true)
    let created: string | undefined
    try {
      const credential = await call('POST executors', {body: {name: computer.name}})
      created = credential.id
      await attachComputer(computer.id, credential)
      created = undefined; setExecutorId(credential.id)
      await devices.reload(); await computers.reload()
    } catch (failure) {
      if (created) await call('POST executors/:id/revoke', {id: created}).catch(() => {})
      setError(String(failure))
    } finally { setBusy(false) }
  }
  const device = devices.data?.find(row => row.id === executorId)
  const submit = async () => {
    const fingerprint = JSON.stringify([text.trim(), executorId, projectId])
    if (identity.current?.fingerprint !== fingerprint) identity.current = {fingerprint, id: crypto.randomUUID()}
    setBusy(true); setError('')
    try {
      const result = await call('POST requests', {body: {requestId: identity.current!.id, text, executorId, projectId}})
      setOpen(false); setText(''); identity.current = null
      await panel.reload(); navigate({page: 'trigger', id: result.thread, query: {trigger: result.triggerId}})
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="primary" size="sm" onClick={() => {setExecutorId(panel.state?.defaultExecutorId ?? null); setProjectId(null); setOpen(true)}}>{t('requestNew')}</Button>
    <Modal open={open} onClose={() => {if (!busy) setOpen(false)}} title={t('requestNew')} closeLabel={t('close')}
      footer={<Button variant="primary" disabled={busy || !text.trim() || !!executorId && !device?.paired} onClick={() => {void submit()}}>{t('requestSubmit')}</Button>}>
      <div className="dt-form">
        <Hint>{t('requestIntro')}</Hint>
        <Field label={t('requestEnvironment')}>
          <select className="dt-select" value={executorId ?? ''} disabled={busy} onChange={event => {void select(event.target.value)}}>
            <option value="">{t('cloudExecutor')}</option>
            {devices.data?.map(row => <option key={row.id} value={row.id}>{row.name}{!row.online ? ` · ${t('computerOffline')}` : ''}</option>)}
            {computers.data?.filter(row => !devices.data?.some(device => device.id === row.executorId)).map(row => <option key={row.id} value={`local:${row.id}`} disabled={!row.ready}>{row.name}{!row.ready ? ` · ${t('computerNeedsSettings')}` : ''}</option>)}
          </select>
        </Field>
        {executorId && <Field label={t('requestProject')}>
          <select className="dt-select" value={projectId ?? ''} disabled={busy} onChange={event => setProjectId(event.target.value || null)}>
            <option value="">{t('requestNoProject')}</option>
            {device?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Hint>{t('requestProjectHint')}</Hint>
          {device && (!device.online || !device.accepting) && <Hint>{t('requestWaitingComputer')}</Hint>}
        </Field>}
        <Field label={t('requestText')}>
          <textarea className="dt-textarea" rows={7} maxLength={32000} disabled={busy} value={text} onChange={event => setText(event.target.value)} />
        </Field>
        <LoadState error={devices.error ?? computers.error} loading={!devices.data} />
        {error && <p className="dt-error" role="alert">{error}</p>}
      </div>
    </Modal>
  </>
}

/** Continue a request thread, including answers to a worker's human_action. */
export function RequestReply({conversation, reload}: {conversation: string; reload: () => Promise<unknown>}) {
  const {t, call} = usePanel()
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const identity = useRef<{text: string; id: string} | null>(null)
  const submit = async () => {
    if (identity.current?.text !== text) identity.current = {text, id: crypto.randomUUID()}
    setBusy(true); setError('')
    try {
      await call('POST requests/:id/messages', {id: conversation, body: {requestId: identity.current!.id, text}})
      setText(''); identity.current = null; await reload()
    } catch (failure) {setError(String(failure))}
    finally {setBusy(false)}
  }
  return <div className="dt-form"><Field label={t('requestFollowup')}>
    <textarea className="dt-textarea" rows={3} maxLength={32000} value={text} disabled={busy} onChange={event => setText(event.target.value)} />
  </Field><div><Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => {void submit()}}>{t('requestSend')}</Button></div>
  {error && <p className="dt-error" role="alert">{error}</p>}</div>
}
