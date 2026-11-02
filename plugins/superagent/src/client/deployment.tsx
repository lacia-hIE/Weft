/** @jsxRuntime automatic */
/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { hookBase } from './access.ts'
import { Button, Icon, Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import type { T } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'

export type DeploymentForm = (ConfigPageForm & { secretSet(field: string): boolean }) | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

const SECRETS = [{ field: 'githubToken', label: 'deploymentToken', hint: 'deploymentTokenHint' }] as const

/** The agent's secrets: written here, and never read back; an empty field leaves what is saved. */
function Secrets({ form, editable, revision }: { form: DeploymentForm; editable: boolean; revision: number | undefined }) {
  const { t, notify, restart } = usePanel()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = SECRETS.filter(({ field }) => values[field]?.trim())
  const save = async () => {
    if (!form || revision === undefined) return
    setBusy(true); setError('')
    try {
      const ops: Op[] = changed.map(({ field }) => ({ op: 'set', path: [field], value: values[field]!.trim() }))
      if (!await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      setValues({}); notify(t('saved')); restart()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <Section title={t('deploymentSecrets')} hint={t('deploymentSecretsHint')}>
    {SECRETS.map(({ field, label, hint }) => <Field key={field} label={t(label)} hint={t(hint)}
      note={form?.secretSet(field) ? t('deploymentSecretSet') : t('deploymentSecretUnset')}>
      <Input type="password" autoComplete="new-password" spellCheck={false} disabled={!editable || busy} value={values[field] ?? ''}
        onChange={event => { setValues({ ...values, [field]: event.target.value }) }} />
    </Field>)}
    {error && <p className="dt-error" role="alert">{error}</p>}
    <div className="dt-row-buttons">
      <Button variant="primary" size="sm" disabled={!editable || busy || !changed.length} onClick={() => { void save() }}>{t('deploymentSecretsSave')}</Button>
    </div>
  </Section>
}

/** One value GitHub's webhook form asks for, with its copy button. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { t, notify } = usePanel()
  const copy = () => { void navigator.clipboard.writeText(value).then(() => { notify(t('webhookCopied', { field: label })) }, () => { notify(t('webhookCopyFailed')) }) }
  return <div className="dt-field">
    <span className="dt-field-head">{label}</span>
    <div className="dt-row-buttons">
      <code className="dt-mono" style={{ overflowWrap: 'anywhere', flex: 1 }}>{value}</code>
      <Button variant="outline" size="sm" icon={<Icon name="copy" size={14} />} aria-label={t('webhookCopy', { field: label })} onClick={copy}>{t('webhookCopyShort')}</Button>
    </div>
  </div>
}
/** A secret just generated, kept only in this page's memory: it is never read back, and saving it reloads the plugin and this view. */
let generatedSecret = ''
/** Everything GitHub's webhook form asks for. The agent's account cannot add a webhook itself, as that takes admin rights on the repository. */
function WebhookSetup({ form, editable, revision, repository }: { form: DeploymentForm; editable: boolean; revision: number | undefined; repository: string | undefined }) {
  const { t, notify, restart } = usePanel()
  const [secret, setSecret] = useState(generatedSecret)
  const [error, setError] = useState('')
  const generate = async () => {
    if (!form || revision === undefined) throw new Error(t('deploymentRefused'))
    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
    if (!await form.mutate([{ op: 'set', path: ['webhookSecret'], value }], revision)) throw new Error(t('deploymentRefused'))
    generatedSecret = value; setSecret(value); setError('')
    // A browser may refuse the clipboard after the save; the value stays on the page with its own button.
    await navigator.clipboard.writeText(value).then(() => { notify(t('webhookCopied', { field: t('webhookSecret') })) }, () => {})
    restart()
  }
  const run = () => generate().catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
  const isSet = form?.secretSet('webhookSecret') === true
  return <Section title={t('webhookTitle')} hint={t('webhookHint')}>
    {repository ? <Hint><a href={`https://github.com/${repository}/settings/hooks/new`} target="_blank" rel="noreferrer">{t('webhookOpen', { repository })}</a></Hint>
      : <Hint>{t('webhookNoRepository')}</Hint>}
    <CopyRow label={t('webhookUrl')} value={`${hookBase()}/github`} />
    <CopyRow label={t('webhookContentType')} value="application/json" />
    {secret ? <CopyRow label={t('webhookSecret')} value={secret} /> : <div className="dt-field">
      <span className="dt-field-head">{t('webhookSecret')}</span><span className="dt-hint">{isSet ? t('deploymentSecretSet') : t('deploymentSecretUnset')}</span>
    </div>}
    {error && <p className="dt-error" role="alert">{error}</p>}
    <div className="dt-row-buttons">
      {isSet || secret ? <ConfirmButton variant="outline" label={t('webhookRegenerate')} title={t('webhookRegenerate')} message={t('webhookRegenerateWarning')} onConfirm={run} />
        : <Button variant="primary" size="sm" disabled={!editable} onClick={() => { void run() }}>{t('webhookGenerate')}</Button>}
    </div>
    <Hint>{t('webhookEvents')}</Hint>
  </Section>
}

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined, secretSet: (field: string) => boolean): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form), secretSet } : undefined, [form, state, secretSet])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Hint>{t('deploymentIntro')}</Hint>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—']]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
      <Secrets form={form} editable={!!editable} revision={editable ? snapshot.revision : undefined} />
      <WebhookSetup form={form} editable={!!editable} revision={editable ? snapshot.revision : undefined} repository={accounts?.repository} />
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
