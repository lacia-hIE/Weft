/** @jsxRuntime automatic */
import {useState} from 'react'
import type {CollaborationNote} from '../app/collaboration.ts'
import {usePoll} from './api.ts'
import {Button} from './controls.tsx'
import {useDraft, SaveBar} from './draft.tsx'
import {usePanel} from './provider.tsx'
import {Field} from './settings-kit.tsx'
import {Select} from './select.tsx'
import {localized} from './text.ts'
import {Hint, LoadState} from './widgets.tsx'

export function CollaborationEditor() {
  const {call, t} = usePanel()
  const view = usePoll(async () => {
    const [notes, settings, executors] = await Promise.all([call('GET collaboration'), call('GET settings'), call('GET executors')])
    return {notes, settings, executors}
  }, [])
  return view.data ? <Notes key="notes" data={view.data} reload={view.reload}/> : <LoadState loading error={view.error}/>
}
function Notes({data, reload}: {data: {notes: Awaited<ReturnType<import('../app/collaboration.ts').Collaboration['view']>>;
  settings: import('./api.ts').SettingsView; executors: import('../app/api.ts').ApiResponse<'GET executors'>}; reload(): Promise<void>}) {
  const {call, t} = usePanel(), [history, setHistory] = useState(false)
  const draft = useDraft({saved: data.notes.notes, revision: data.notes.revision, reload,
    save: async (notes: CollaborationNote[], revision) => call('PUT collaboration', {body: {revision, notes}})})
  const change = (id: string, next: Partial<CollaborationNote>) => draft.edit(draft.value.map(note => note.id === id ? {...note, ...next} : note))
  const scopes = [{value: 'all', label: t('collaborationAll')}, ...data.settings.sources.map(source => ({value: `source:${source.id}`, label: localized(t, source.title)})),
    ...data.executors.map(executor => ({value: `executor:${executor.id}`, label: executor.name}))]
  return <div className="dt-form">
    <Hint>{t('collaborationIntro')}</Hint>
    <div><Button variant="outline" onClick={() => draft.edit([...draft.value, {id: crypto.randomUUID(), text: '', kind: 'requirement', scope: {kind: 'all'}, evidence: {}}])}>{t('collaborationAdd')}</Button></div>
    {draft.value.map(note => <div className="dt-card dt-form" key={note.id}>
      <div className="dt-grid3">
        <Field label={t('collaborationScope')}><Select value={note.scope.kind === 'all' ? 'all' : `${note.scope.kind}:${note.scope.id}`} placeholder={t('collaborationScope')}
          options={scopes} onChange={value => {const [kind, ...parts] = value.split(':'); change(note.id, {scope: kind === 'all' ? {kind: 'all'} : {kind: kind as 'source' | 'executor', id: parts.join(':')}})}}/></Field>
        <Field label={t('collaborationKind')}><Select value={note.kind} placeholder={t('collaborationKind')}
          options={(['requirement', 'environment', 'experience'] as const).map(kind => ({value: kind, label: t(`collaborationKind.${kind}`)}))}
          onChange={kind => change(note.id, {kind: kind as CollaborationNote['kind']})}/></Field>
      </div>
      <Field label={t('collaborationText')}><textarea className="dt-textarea" rows={4} maxLength={4000} value={note.text} onChange={event => change(note.id, {text: event.target.value})}/></Field>
      {(note.evidence.triggerId || note.evidence.ticketId) && <Hint>{t('collaborationEvidence')}: {note.evidence.triggerId ?? `${note.evidence.ticketId} / ${note.evidence.assignmentId}`}</Hint>}
      <div><Button variant="ghost" size="sm" onClick={() => draft.edit(draft.value.filter(item => item.id !== note.id))}>{t('remove')}</Button></div>
    </div>)}
    <div><Button variant="ghost" onClick={() => setHistory(!history)}>{t('collaborationHistory')}</Button></div>
    {history && data.notes.history.map(snapshot => <div key={snapshot.revision} className="dt-row">
      <span>{snapshot.revision} · {snapshot.origin} · {snapshot.at}</span>
      <Button size="sm" variant="outline" onClick={() => draft.edit(snapshot.notes)}>{t('collaborationRestore')}</Button>
    </div>)}
    <SaveBar {...draft} onDiscard={draft.discard}/>
  </div>
}
