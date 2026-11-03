/** Lifecycle, instructions, tools and message delivery of the orchestrator and worker Sessions, through the Host's session services. */
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import type { Variable } from './execution-environment.ts'
import type { HostSessionController, HostManagedSessions, HostSessionEvents } from '../host-services.ts'

export interface SessionsHost {
  readonly controller: HostSessionController
  readonly managed: HostManagedSessions
  readonly events: HostSessionEvents
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys' | 'delete'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  readonly masterId: string
  readonly lifetime: AbortSignal
  /** Execution environment variables for `ticket`, rendered into its worker's instructions. */
  environment(ticket: Ticket): Variable[]
  /** Instructions added for `ticket`'s mandate. */
  mandate(ticket: Ticket): string
  /** Names of the scoped tools each role is offered. */
  tools(role: 'orchestrator' | 'worker'): string[]
}
export type Role = 'orchestrator' | 'worker'
/**
 * The tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and subagents,
 * the Host's switch to a container and its MCP servers. It gets no other tool, whenever it was registered: none that asks or
 * shows a person something, changes the environment, schedules work or starts goals outside the worker slots, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent', 'workspace_runtime', 'mcp__*']
const MAIN_TOOLS = ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']
export const ticketOfSessionId = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined

/**
 * Creates and configures orchestrator and worker Sessions with role models, instructions from `Prompts` and their tools.
 * A Session's prompt revision is recorded on each configuration in `Store` (`KV.sessions.prompts`).
 * Notices for the main Session wait in `Store` and travel with its next message, so they do not wake a model on their own.
 */
export class Sessions {
  constructor(private readonly host: SessionsHost) {
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.collect(name, value, summary), { ordered: true })
  }
  /** Creates Session `id` once in directory `cwd`, then applies its current instructions and tools. */
  async ensure(id: string, cwd: string, title: string, role: Role, ticket?: Ticket): Promise<void> {
    const { store, controller } = this.host
    const settings = store.settings()
    if (!store.get(KV.sessions.created(id))) {
      const { sessionId } = await controller.create({ sessionId: id, cwd, permissionPreset: settings.executor.permission })
      if (sessionId !== id) throw new Error(`Session ${id} already exists outside dsh-superagent`)
      const model = role === 'orchestrator' ? settings.eval.model : settings.executor.model
      if (model) await controller.selectModel({ sessionId: id, provider: model.provider, model: model.model, ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {} })
      await controller.rename({ sessionId: id, title })
      store.set(KV.sessions.created(id), true)
    }
    await this.configure(id, role, ticket)
    await this.host.events.watch(id)
  }
  /** Applies the current prompt revision; a Session reads it before its next turn. */
  configuration(role: Role, ticket?: Ticket): { instructions: string; tools: string[]; allow: string[] } {
    const { prompts, store } = this.host
    const version = prompts.current()
    const text = `[dsh-superagent prompt revision ${version.revision}]\n${prompts.compose(version.config, role, ticket ? this.host.environment(ticket) : undefined)}\n${ticket ? this.host.mandate(ticket) : ''}`
    const skills = prompts.skills(version.config).map(([name, content]) => `## skill: dsh-superagent-${name}\n${content}`).join('\n\n')
    const current = ticket && store.tickets.get(ticket.id)
    return { instructions: skills ? `${text}\n\n${skills}` : text, tools: this.host.tools(role),
      allow: role === 'orchestrator' ? MAIN_TOOLS : current && !liveTicket(current) ? [] : WORK_TOOLS }
  }
  async configure(id: string, role: Role, ticket?: Ticket): Promise<void> {
    const { store, prompts, managed } = this.host
    const version = prompts.current()
    const { instructions, tools, allow } = this.configuration(role, ticket)
    const stamp = key(instructions, tools.join(), allow.join())
    if (store.get(KV.sessions.configured(id)) === stamp) return
    await managed.configure(id, { instructions, tools, allow })
    store.set(KV.sessions.configured(id), stamp)
    const revisions = store.get(KV.sessions.prompts(id)) ?? []
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(id), [...revisions.filter(revision => revision !== version.revision), version.revision])
  }
  /** Returns whether `sessionId` was already sent the message delivered under `requestId`. */
  holds(sessionId: string, requestId: string): boolean { return !!this.host.store.get(KV.sessions.sent(sessionId, key(requestId))) }
  /** Delivers a message once per request id, to the next turn (`queue`) or the current one (`steer`); the Host's inbox deduplicates a repeated id. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer', authorize?: () => void, accepted?: () => void): Promise<void> {
    this.host.lifetime.throwIfAborted()
    authorize?.()
    const { store } = this.host
    const waiting = sessionId === this.host.masterId ? this.notices() : ''
    await this.host.controller.prompt({ sessionId, requestId: key(requestId), mode, content: [{ type: 'text', text: waiting ? `${waiting}\n\n${text}` : text }] })
    if (waiting) store.delete(KV.sessions.notices)
    store.set(KV.sessions.sent(sessionId, key(requestId)), true)
    accepted?.()
  }
  /** The Host request id `prompt` sends under `requestId`, which the Session's `user/message` events carry as `rpcId`. */
  promptedId(requestId: string): string { return key(requestId) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` was collected for the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  private collect(name: string, value: Record<string, unknown>, summary: string): void {
    const { store } = this.host
    store.set(KV.sessions.notices, { ...store.get(KV.sessions.notices), [name]: { value, summary } })
  }
  private notices(): string {
    const waiting = this.host.store.get(KV.sessions.notices)
    if (!waiting || !Object.keys(waiting).length) return ''
    return Object.values(waiting).map(({ value, summary }) => `[notice: ${summary}] ${JSON.stringify(value)}`).join('\n')
  }
  /** Returns the current prompt revision, the prompt revision of each Session, and whether a `'prompts'` notice still waits to be collected. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return revision === undefined ? [] : [{ sessionId, revision }]
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one last configured on it, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  modelRetry(_sessionId: string | undefined) { return {} }
}
