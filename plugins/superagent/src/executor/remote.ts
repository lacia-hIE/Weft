/** A remote Executor owns execution, never Sources, Policy or another environment. */
import { z } from 'zod'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson, type Assignment, type Executor, type Ticket } from '../core/index.ts'
import { family } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { toolParameters } from '../app/tools/parameters.ts'
import { inputMessage } from './dsh.ts'

export const EXECUTOR_PROTOCOL = 'weft-executor/1'
interface Device { id: string; name: string; pairHash?: string; expires?: number; tokenHash?: string; seen?: number; accepting?: boolean }
interface Message { id: string; text: string; inputs: string[] }
interface Job { ticketId: string; assignmentId: string; executorId: string; messages: Message[]; accepted: string[];
  revision: number; state: 'queued' | 'dispatched' | 'running' | 'waiting' | 'failed' | 'stopping' | 'stopped'; sessionId?: string; error?: string }
interface Receipt { fingerprint: string; result?: unknown; complete: boolean }
const devices = family<Device>('remote-device:'), jobs = family<Job>('remote-job:')
const receipts = family<Receipt, [string, string]>('remote-receipt:')
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
const identity = z.string().regex(/^[a-f0-9]{32}$/), messageId = z.string().min(1).max(180)
const Sync = z.object({ protocol: z.literal(EXECUTOR_PROTOCOL), accepting: z.boolean(),
  states: z.array(z.object({ ticketId: identity, assignmentId: identity, revision: z.number().int().nonnegative(),
    state: z.enum(['running', 'waiting', 'failed', 'stopped']), sessionId: z.string().min(1).max(180),
    accepted: z.array(messageId).max(200), read: z.array(messageId).max(200).default([]), error: z.string().max(4000).optional(), summary: z.string().max(12000).optional() }).strict()).max(100),
}).strict()
const Call = z.object({ ticketId: identity, assignmentId: identity, requestId: messageId, name: z.string().min(1).max(100), args: z.unknown() }).strict()
export interface RemoteExecutorHost {
  store: Store
  engine: Pick<import('../core/index.ts').EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'report'>
  configuration(ticket: Ticket): { instructions: string; allow: string[] }
  tools(ticket: Ticket): Tool[]
  changed(): void
  notify?(ticket: Ticket, state: 'waiting' | 'failed', summary: string): void
}

export class ExecutorRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export class RemoteExecutor implements Executor {
  constructor(private readonly host: RemoteExecutorHost) {}
  list() {
    return this.host.store.keys(devices.prefix).map(key => this.host.store.get<Device>(key)!).map(device => ({
      id: device.id, name: device.name, paired: !!device.tokenHash, online: !!device.seen && Date.now() - device.seen < 90_000,
      accepting: device.accepting ?? false, lastSeen: device.seen ?? null,
    }))
  }
  status(ticketId: string) {
    const job = this.host.store.get(jobs(ticketId))
    if (!job) return undefined
    const device = this.list().find(device => device.id === job.executorId)
    return { name: device?.name ?? job.executorId, online: device?.online ?? false, state: job.state, sessionId: job.sessionId ?? '' }
  }
  async create(name: string) {
    if (this.list().length >= 32) throw new ExecutorRequestError(400, 'At most 32 execution computers may be registered')
    const id = crypto.randomUUID(), pairingKey = secret(), expires = Date.now() + 10 * 60_000
    this.host.store.set(devices(id), { id, name, pairHash: await hash(pairingKey), expires })
    return { id, pairingKey, expires, protocol: EXECUTOR_PROTOCOL }
  }
  revoke(id: string): void {
    if (!this.host.store.get(devices(id))) throw new ExecutorRequestError(404, 'Execution computer not found')
    this.host.store.delete(devices(id))
  }
  async pair(id: string, key: string) {
    const digest = await hash(key)
    const token = secret(), tokenHash = await hash(token)
    return this.host.store.atomic(() => {
      const device = this.host.store.get(devices(id))
      if (!device?.pairHash || device.pairHash !== digest || (device.expires ?? 0) < Date.now()) throw new ExecutorRequestError(401, 'Pairing code expired or already used')
      this.host.store.set(devices(id), { id, name: device.name, tokenHash })
      return { token, protocol: EXECUTOR_PROTOCOL }
    })
  }
  async authenticate(id: string, token: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(token) || !this.host.store.get(devices(id))?.tokenHash
      || this.host.store.get(devices(id))?.tokenHash !== await hash(token)) throw new ExecutorRequestError(401, 'Executor authorization required')
  }
  private job(ticket: Ticket): Job | undefined { return this.host.store.get(jobs(ticket.id)) }
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.job(ticket)?.assignmentId === assignment.id) return
    const executorId = ticket.execution?.executorId
    if (!executorId) throw new Error('Missing execution computer')
    const source = this.host.store.triggers.get(ticket.origin.triggerId)
    const text = JSON.stringify({ ticket_id: ticket.id, title: ticket.title, assignment: ticket.execution?.assignment,
      trigger: source, prepare_directory: this.host.store.settings().executor.prepare,
      recovery: ticket.assignments.length > 1 ? 'Inspect the retained directory, git history and PR before repeating outside actions.' : undefined })
    this.host.store.set(jobs(ticket.id), { ticketId: ticket.id, assignmentId: assignment.id, executorId,
      messages: [{ id: `assignment:${assignment.id}`, text, inputs: [] }], accepted: [], revision: -1, state: 'queued' })
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    const job = this.job(ticket)
    if (!job || job.assignmentId !== assignment.id || job.state === 'stopping' || job.state === 'stopped') return
    for (const id of ticket.undelivered) {
      const requestId = `${assignment.id}:${id}`
      if (job.messages.some(message => message.id === requestId)) continue
      const input = ticket.inputs.find(item => item.id === id)
      if (!input) continue
      const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
      const text = inputMessage(input, trigger)
      if (text !== undefined) job.messages.push({ id: requestId, text, inputs: [id] })
    }
    this.host.store.set(jobs(ticket.id), job)
  }
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    const job = this.job(ticket)
    if (job?.assignmentId === assignment.id) this.host.store.set(jobs(ticket.id), { ...job, state: 'stopping' })
  }
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => ['dispatched', 'running'].includes(this.job(ticket)?.state ?? '')).length }
  resume(): void {
    for (const ticket of this.host.store.tickets.open()) {
      const assignment = latestAssignment(ticket)
      if (ticket.execution?.executorId && assignment?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, assignment)
    }
  }
  /** A sync is a snapshot with monotonic per-Assignment revisions; replay never starts or ends work twice. */
  sync(id: string, raw: unknown) {
    const input = Sync.parse(raw), { store, engine } = this.host
    store.atomic(() => {
      const device = store.get(devices(id))
      if (!device) throw new ExecutorRequestError(401, 'Executor revoked')
      store.set(devices(id), { ...device, seen: Date.now(), accepting: input.accepting })
      for (const state of input.states) {
        const job = store.get(jobs(state.ticketId)), ticket = store.tickets.get(state.ticketId)
        if (!job || job.executorId !== id || job.assignmentId !== state.assignmentId || state.revision <= job.revision) continue
        if (!ticket || latestAssignment(ticket)?.id !== state.assignmentId) continue
        if (job.state === 'stopping' && state.state !== 'stopped') continue
        if (!liveTicket(ticket) && state.state !== 'stopped') continue
        if (state.state !== 'stopped' && latestAssignment(ticket)?.state === 'pending') engine.assignmentStarted(ticket.id, state.assignmentId)
        const latest = store.get(jobs(ticket.id)) ?? job
        const accepted = state.accepted.filter(value => latest.messages.some(message => message.id === value))
        const delivered = latest.messages.filter(message => accepted.includes(message.id) && !job.accepted.includes(message.id)).flatMap(message => message.inputs)
        if (delivered.length) engine.inputsDelivered(ticket.id, state.assignmentId, delivered)
        const read = latest.messages.filter(message => state.read.includes(message.id)).flatMap(message => message.inputs)
        if (read.length) engine.inputsRead(ticket.id, read)
        if (state.state === 'waiting' && runningAssignment(store.tickets.get(ticket.id)!) && !waitsForPerson(store.tickets.get(ticket.id)!)) {
          engine.turnEnded(ticket.id, state.assignmentId)
          const current = store.tickets.get(ticket.id)!, report = runningAssignment(current)?.report
          if ((!report || report.state === 'progress') && !current.attention) {
            const summary = state.summary || report?.summary || 'Executor is waiting for input.'
            this.host.notify?.(engine.report(ticket.id, { state: 'waiting', summary }), 'waiting', summary)
          }
        }
        if (state.state === 'failed' && job.state !== 'failed' && liveTicket(store.tickets.get(ticket.id)!)) {
          const summary = state.error || 'Local executor failed'
          this.host.notify?.(engine.report(ticket.id, { state: 'failed', summary }), 'failed', summary)
        }
        store.set(jobs(ticket.id), { ...store.get(jobs(ticket.id))!, revision: state.revision, state: state.state, sessionId: state.sessionId,
          accepted: [...new Set([...job.accepted, ...accepted])], ...state.error ? { error: state.error } : {} })
      }
    })
    const commands: unknown[] = []
    for (const key of store.keys(jobs.prefix)) {
      const job = store.get<Job>(key)!
      if (job.executorId !== id) continue
      const ticket = store.tickets.get(job.ticketId)
      if (!ticket) continue
      const ended = !liveTicket(ticket) || latestAssignment(ticket)?.id !== job.assignmentId
      if (ended || job.state === 'stopping') {
        if (job.state !== 'stopped') commands.push({ kind: 'stop', ticketId: ticket.id, assignmentId: job.assignmentId })
        continue
      }
      if (store.settings().paused || !input.accepting || waitsForPerson(ticket)) continue
      const messages = job.messages.filter(message => !job.accepted.includes(message.id))
      if (!messages.length) continue
      if (!['dispatched', 'running'].includes(job.state)) {
        if (this.activeCount() >= store.settings().executor.maxWorkers) continue
        store.set(jobs(job.ticketId), { ...job, state: 'dispatched' })
      }
      commands.push({ kind: 'run', ticketId: ticket.id, assignmentId: job.assignmentId, name: ticket.execution!.name,
        directory: ticket.execution!.directory, title: ticket.title, ...this.host.configuration(ticket),
        tools: this.host.tools(ticket).map(tool => ({ name: tool.name, description: tool.description, parameters: toolParameters(tool.schema) })), messages })
      if (commands.length >= 4) break
    }
    this.host.changed()
    return { protocol: EXECUTOR_PROTOCOL, commands, acknowledged: input.states.map(state => ({ ticketId: state.ticketId, assignmentId: state.assignmentId, revision: state.revision })), retryAfterMs: commands.length ? 1000 : 15_000 }
  }
  /** Executor credentials grant only the tools of the current Assignment; router tools are never exposed. */
  async call(id: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = Call.parse(raw), { store } = this.host
    const job = store.get(jobs(request.ticketId)), ticket = store.tickets.get(request.ticketId)
    if (!job || job.executorId !== id || job.assignmentId !== request.assignmentId || !ticket || !liveTicket(ticket)
      || latestAssignment(ticket)?.id !== request.assignmentId || job.state === 'stopping' || job.state === 'stopped') throw new ExecutorRequestError(403, 'Assignment is no longer authorized')
    const tool = this.host.tools(ticket).find(tool => tool.name === request.name)
    if (!tool) throw new ExecutorRequestError(403, 'Tool is not available to this Executor')
    const args = tool.schema.parse(request.args)
    const key = receipts(request.assignmentId, request.requestId), fingerprint = await hash(JSON.stringify([request.name, args]))
    if (!store.get(devices(id))?.tokenHash || !liveTicket(store.tickets.get(ticket.id)!)
      || latestAssignment(store.tickets.get(ticket.id)!)?.id !== request.assignmentId) throw new ExecutorRequestError(403, 'Assignment authorization changed')
    const old = store.get(key)
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ExecutorRequestError(409, 'Request identity was reused with different arguments')
      if (!old.complete) throw new ExecutorRequestError(409, 'Earlier tool outcome is uncertain; inspect the Ticket before repeating it')
      return old.result
    }
    store.set(key, { fingerprint, complete: false })
    if (latestAssignment(ticket)?.state === 'pending') this.host.engine.assignmentStarted(ticket.id, request.assignmentId)
    const result = JSON.parse(JSON.stringify(await tool.execute(args as never, signal) ?? {})) as unknown
    store.set(key, { fingerprint, complete: true, result })
    this.host.changed()
    return result
  }
}
