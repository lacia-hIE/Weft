/** @jsxRuntime automatic */
/** Source secrets use native write-only Settings fields, outside ordinary settings/history. */
import {useState} from 'react'
import type {DeploymentForm} from './deployment.tsx'
import {hookBase} from './access.ts'
import {Button, Input} from './controls.tsx'
import {usePanel, usePanelData} from './provider.tsx'
import {Field} from './settings-kit.tsx'
import {Hint} from './widgets.tsx'

export function SourceCredentials({id, kind, form}: {id: string; kind: string; form?: DeploymentForm}) {
  const {t, notify, restart} = usePanel(), {state} = usePanelData()
  const [values, setValues] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const snapshot = form?.state, editable = snapshot?.status === 'ready' && snapshot.writable
  const flags = state?.setup.sourceSecrets[id]
  const fields = kind === 'feed' ? ['feed'] as const : ['webhook', 'feed', 'token'] as const
  const labels = {webhook: t('sourceWebhookSecret'), feed: t('sourceFeedAddress'), token: t('sourceApiCredential')}
  const save = async (name: typeof fields[number], value: string) => {
    if (!form || !editable) return
    setBusy(true);setError('')
    try {
      if (!await form.mutate([{op: 'set', path: ['sourceSecrets', `${id}-${name}`], value}], snapshot.revision)) throw new Error(t('deploymentRefused'))
      setValues(previous => ({...previous, [name]: ''}));notify(t('saved'));restart()
    } catch (failure) {setError(String(failure))}
    finally {setBusy(false)}
  }
  return <div className="dt-form">
    {kind !== 'feed' && <div className="dt-field"><span>{t('sourceCallback')}</span><code style={{overflowWrap: 'anywhere'}}>{`${hookBase()}/source-events/${id}`}</code></div>}
    {fields.map(name => <div key={name} className="dt-form">
      <Field label={labels[name]} note={flags?.[name] ? t('deploymentSecretSet') : t('deploymentSecretUnset')}>
        <Input type="password" autoComplete="new-password" value={values[name] ?? ''} disabled={!editable || busy}
          onChange={event => setValues(previous => ({...previous, [name]: event.target.value}))}/>
      </Field>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" disabled={!editable || busy || !values[name]?.trim()} onClick={() => {void save(name, values[name]!.trim())}}>{t('sourceSaveSecret')}</Button>
        {flags?.[name] && <Button variant="ghost" size="sm" disabled={!editable || busy} onClick={() => {void save(name, '')}}>{t('removeCredential')}</Button>}
        {name === 'webhook' && <Button variant="ghost" size="sm" disabled={!editable || busy} onClick={() => {
          const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
          setValues(previous => ({...previous, webhook: value}));void navigator.clipboard.writeText(value).then(() => notify(t('sourceSecretCopied')), () => {})
        }}>{t('sourceGenerateSecret')}</Button>}
      </div>
    </div>)}
    <Hint>{t(kind === 'gitlab' ? 'sourceGitlabSecretHint' : 'sourceCredentialsHint')}</Hint>
    {error && <p role="alert" className="dt-error">{error}</p>}
  </div>
}
