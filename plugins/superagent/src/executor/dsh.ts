/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import { KV } from '../kv.ts'
import type { HostFs, HostSessionController, SessionEvent } from '../host-services.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** A turn that reported no end for this long is recorded as failed, so a lost Session cannot hold a worker slot forever. */
const TURN_LIMIT_MS = 6 * 3600_000
/** Newest messages read to find what a turn did; `page` aligns history to messages. */
const TURN_PAGE_MESSAGES = 40
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  readonly controller: Pick<HostSessionController, 'cancel' | 'page'>
  readonly fs: Pick<HostFs, 'resolve' | 'writeText'>
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'get' | 'set' | 'delete' | 'keys' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: `${executionRoot(settings).replace(/\/+$/, '')}/${name}`, assignment }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket worker Sessions and directories, through the Host's session services.
 * Queues launches and input deliveries through Effects and manages concurrency with WorkerSlots. A turn's end arrives as a
 * hint from the Host, or is found on the next reconcile, and what the turn did is read from the Session's own log, so a
 * lost hint or an evicted environment only delays it.
 */
export class DshExecutor implements Executor {
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Registers the effect handlers; launches and deliveries are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
    host.effects.handle('continue', payload => this.continueQueued(payload), { limit: () => host.paused() ? 0 : 4, retry: [TRANSIENT_BACKOFF_MS, 300_000], quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings()) }
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // A pause re-queues the launch, and transient network/provider errors retry with backoff.
      if (error instanceof Later) throw error
      if (this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          await this.host.sessions.ensure(workerSessionId(ticketId), ticket.execution?.directory ?? '', ticket.title, 'worker', ticket)
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.send(ticket.id, input.id, text, 'steer', live)
  }
  /** Sends a worker a message, which starts or joins a turn, so its slot is held until that turn is seen to end. */
  private async send(ticketId: string, requestId: string, text: string, mode: 'queue' | 'steer', authorize?: () => void, accepted?: () => void): Promise<void> {
    await this.host.sessions.prompt(workerSessionId(ticketId), requestId, text, mode, authorize, () => {
      this.host.store.set(KV.executor.busy(ticketId), Date.now())
      accepted?.()
    })
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): cancels its turn unless its last word was a `ready` or `dropped` report with no Input delivered since.
   */
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.host.store.delete(KV.executor.busy(ticket.id))
      if (!ownTurn) void this.background(this.host.controller.cancel({ sessionId }).then(() => {}, () => { /* A Session that never started has no turn to cancel. */ }))
    })
  }
  /** Number of open tickets whose worker holds a worker slot. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: a message reached it and its turn has not been seen to end. */
  private running(ticket: Ticket): boolean {
    return !!runningAssignment(ticket) && this.host.store.get(KV.executor.busy(ticket.id)) !== undefined
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // A Session's directory has to exist before it opens there; writing a marker creates it.
    if (!this.host.store.get(KV.executor.prepared(ticket.id))) {
      await this.host.fs.writeText(await this.host.fs.resolve(`${workspace}/.superagent-ticket`), `${ticket.id}\n`)
      this.host.store.set(KV.executor.prepared(ticket.id), true)
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker', ticket)
    if (!current()) return
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && this.host.sessions.holds(sessionId, first)
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const prepare = told ? '' : this.host.store.settings().executor.prepare.trim()
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(prepare ? { prepare_directory: prepare } : {}),
        ...(card ? { trigger: card } : {}), ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.send(ticket.id, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
  }
  /** Goes on with a worker turn that failed for a passing reason, once its backoff passed and a slot is free. */
  private async continueQueued({ ticketId, assignmentId, attempt, at, text }: { ticketId: string; assignmentId: string; attempt: number; at: number; text: string }): Promise<void> {
    if (Date.now() < at) throw new Later('The backoff of a passing failure has not passed')
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
    if (!this.running(ticket)) this.slots.reserve(ticketId, 'wake')
    try { await this.send(ticketId, `retry:${assignmentId}:${attempt}`, text, 'queue') }
    finally { this.slots.free(ticketId) }
  }
  /** Reads the Session's log after a turn-end hint, or on a reconcile; a repeated hint finds nothing new. */
  async turnEnded(sessionId: string): Promise<void> {
    const ticketId = ticketOfSession(sessionId)
    const ticket = ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
    if (!ticket || !ticketId) return
    const cursor = this.host.store.get(KV.executor.cursor(ticketId)) ?? -1
    const { records } = await this.host.controller.page({ address: { kind: 'session', sessionId }, maxMessages: TURN_PAGE_MESSAGES })
    const events = records.flatMap(record => record.event && record.event.seq > cursor ? [record.event] : []).sort((a, b) => a.seq - b.seq)
    if (!events.length) return
    this.readInputs(ticket, sessionId, events)
    const end = events.findLast(event => event.type === 'turn/end')
    // What came after the last turn end belongs to a turn that still runs, and is read again at its end.
    if (!end) return
    this.host.store.set(KV.executor.cursor(ticketId), end.seq)
    if (events.at(-1) !== end) return
    this.host.store.delete(KV.executor.busy(ticketId))
    const fresh = this.host.store.tickets.get(ticketId)
    const assignment = fresh && runningAssignment(fresh)
    if (!fresh || !assignment || !liveTicket(fresh)) return
    const reason = (end.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason
    if (reason?.kind === 'error') { this.turnFailed(fresh, assignment, reason.error?.message ?? 'The turn failed'); return }
    this.transient.delete(assignment.id)
    // A cancelled turn was stopped on purpose, by a person or by the end of its Assignment.
    if (reason?.kind === 'aborted') return
    this.workerIdle(fresh, assignment, events)
  }
  /** The Inputs a message of dsh-superagent's carries, which its worker read once the Session took the message into its history. */
  private readInputs(ticket: Ticket, sessionId: string, events: readonly SessionEvent[]): void {
    const taken = new Set(events.flatMap(event => {
      if (event.type !== 'user/message') return []
      const id = (event.data as { source?: { rpcId?: unknown } } | undefined)?.source?.rpcId
      return typeof id === 'string' ? [id] : []
    }))
    const read = ticket.inputs.filter(input => input.kind === 'trigger' && !input.readAt && taken.has(this.host.sessions.promptedId(input.id))).map(input => input.id)
    if (read.length) this.host.engine.inputsRead(ticket.id, read)
    // A message that did not come through `prompt` was typed by a person into the worker's Session.
    if ([...taken].some(id => !this.host.store.get(KV.sessions.sent(sessionId, id)))) this.host.store.set(KV.executor.personal(ticket.id), new Date().toISOString())
  }
  private turnFailed(ticket: Ticket, assignment: Assignment, error: string): void {
    if (!this.retries(assignment.id, error)) { this.failed(ticket.id, error); return }
    const attempt = this.transient.get(assignment.id)!
    const text = `Your last turn failed for a passing reason (${error.slice(0, 200)}). Continue the assignment where it stopped.`
    this.host.effects.enqueue('continue', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id, attempt, at: Date.now() + TRANSIENT_BACKOFF_MS * 2 ** (attempt - 1), text })
  }
  /** A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person; otherwise it reports waiting with its last words. */
  private workerIdle(ticket: Ticket, idle: Assignment, events: readonly SessionEvent[]): void {
    const assignment = runningAssignment(ticket), report = assignment?.report
    const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const handedOff = ((report?.state === 'ready' || !!ticket.attention) && !since) || waitsForPerson(ticket)
    this.host.engine.turnEnded(ticket.id, idle.id)
    const person = this.host.store.get(KV.executor.personal(ticket.id))
    // A turn a person started in the Session ends like any other, even after a handoff.
    if (handedOff && !(report && person && person > report.at)) return
    if (handedOff) return
    const said = lastWords(events)
    this.host.store.atomic(() => {
      const before = latestReport(ticket)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
    })
  }
  /** Finds turn ends whose hints were lost, and lets go of a worker that reported no end for too long. */
  async reconcile(): Promise<void> {
    for (const ticket of this.host.store.tickets.open()) {
      const since = this.host.store.get(KV.executor.busy(ticket.id))
      if (since === undefined) continue
      await this.turnEnded(workerSessionId(ticket.id)).catch((error: unknown) => { this.host.health.set({ state: 'error', detail: String(error), at: now() }) })
      if (this.host.store.get(KV.executor.busy(ticket.id)) === undefined || Date.now() - since < TURN_LIMIT_MS) continue
      this.host.store.delete(KV.executor.busy(ticket.id))
      if (runningAssignment(ticket)) this.failed(ticket.id, `The worker's Session reported no end of its turn for ${TURN_LIMIT_MS / 3600_000} hours.`)
    }
  }
  /** Requeues pending launches, which an earlier activation may not have run; failed launches (`waitsForPerson`) wait for a person's message or a retry. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const latest = latestAssignment(ticket)
      if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
}
/** The text of the last assistant message among `events`. */
function lastWords(events: readonly SessionEvent[]): string {
  const last = events.findLast(event => event.type === 'assistant/message')?.data as { message?: { content?: { type: string; text?: string }[] } } | undefined
  return (last?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
}
