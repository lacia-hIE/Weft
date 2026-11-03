/** Application composition root and lifecycle manager for dsh-superagent. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Engine, key, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { machineOf, type Deployment, type DeploymentConfig, type Machine } from '../deployment.ts'
import { DshExecutor, mandateInstructions, sourceTrigger, workerSessionId } from '../executor/dsh.ts'
import type { HostFs, HostManagedSessions, HostSessionController, HostSessionEvents } from '../host-services.ts'
import { Commands } from '../infra/commands.ts'
import { HealthBoard } from '../infra/health.ts'
import type { SqlService } from '../infra/sql.ts'
import { KV } from '../kv.ts'
import { settingsPolicy } from '../policy.ts'
import { githubKind, pollDue } from '../sources/github.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { SourceRegistry } from '../sources/registry.ts'
import type { SetupProblem } from '../setup.ts'
import { MasterAssessor } from './assessment.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Prompts } from './prompts.ts'
import type { ResourceHost } from './resources.ts'
import { Sessions, ticketOfSessionId } from './sessions.ts'
import { Settings } from './settings.ts'
import { Setup } from './setup.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import { Store } from './store.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { toolParameters } from './tools/parameters.ts'
import type { Tool } from './tools/tool.ts'
import { evalsHealth } from './views/overview.ts'
import type { LinkTarget } from './views/records.ts'

const now = (): string => new Date().toISOString()
/** The main Session's id; one environment holds one dsh-superagent. */
const MASTER_ID = 'orchestrator-main'
/** How long one wake waits for retries that come due soon, inside a Host request's deadline. */
const DRIVE_WINDOW_MS = 40_000, DRIVE_STEP_MS = 2000

/** The Host services dsh-superagent's Cordis context provides. */
export interface HostServices {
  weftSql: SqlService
  sessionController: HostSessionController
  weftSessionEvents: HostSessionEvents
  weftManagedSessions: HostManagedSessions
  fs: HostFs
  tools: { register(tool: unknown): () => void }
  webServer: { register(route: unknown): () => void }
}
export type HostContext = Context & HostServices

/**
 * Composition root of dsh-superagent connecting `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`,
 * `Sessions`, `Settings`, `Prompts`, `DshExecutor` and `MasterAssessor`. All of its state is in the facet's SQLite, so an
 * activation holds nothing that a later wake could not read back; webhooks, turn ends, tool calls and a low-frequency timer
 * each drive what is due and let the environment hibernate between them.
 */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly machine: Machine
  readonly ready: Promise<void>
  readonly masterId = MASTER_ID
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private readonly githubContext: SourceContext
  private driving?: Promise<void> | undefined
  private readonly disposers: (() => void)[] = []
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(private readonly ctx: HostContext, private readonly config: DeploymentConfig, restart: () => void) {
    const runtime = this
    this.machine = machineOf(config)
    const report = (error: unknown) => { console.warn('dsh-superagent:', String(error)) }
    const store = this.store = new Store(ctx.weftSql, report)
    const setup = this.setup = new Setup({ machine: this.machine, token: () => config.githubToken, lifetime: this.lifetime, restart })
    const deployed = () => setup.configured() ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
    const prompts = this.prompts = new Prompts(store, () => config.promptMaxChars, deployed)
    const commands = this.commands = new Commands(() => setup.deployment, () => config.githubToken, this.lifetime)
    const board = this.board
    const effects = this.effects = new Effects(store, board)
    const sources = this.sources = new SourceRegistry(() => store.settings(), board)
    const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
    const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
    const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId: MASTER_ID, controller: ctx.sessionController,
      promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision), sourceLink: link }
    const sessions = this.sessions = new Sessions({ controller: ctx.sessionController, managed: ctx.weftManagedSessions, events: ctx.weftSessionEvents, store, prompts, effects,
      masterId: MASTER_ID, lifetime: this.lifetime, environment: ticket => this.ticketEnvironment(ticket), mandate: ticket => mandateInstructions(ticket.mandate),
      tools: role => this.toolNames[role] })
    const policyChanged: EngineForSettings['policyChanged'] = (from, to, changes) => { this.engine.policyChanged(from, to, changes) }
    this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, lifetime: this.lifetime, sessions, sourceHost: this, setup, requestPass: () => { this.passes.request() } })
    this.executor = new DshExecutor({ controller: ctx.sessionController, fs: ctx.fs, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'),
      lifetime: this.lifetime, sessions, paused: () => this.paused(), sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
    this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
      settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
      deliver: (id, text) => sessions.prompt(MASTER_ID, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
    const outbox = this.outbox = new Outbox({ store, effects, sources, paused: () => this.paused() })
    const { assessor, executor } = this
    const policy = () => settingsPolicy(store.settings(), sources)
    const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
      // Notify the main Session only about domain events it did not initiate itself.
      const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
      if (notice) sessions.notify(...notice)
      // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
      // and of one for an ended ticket once it resumes, unless it routed the message there itself.
      const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
      const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
      if (followup) sessions.relay(followup.id, followup.text)
      // Notify the ticket's conversations whenever it ends via a pull request.
      const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
      if (ended) effects.enqueue('settle', ended.id, { ticketId: ended.id })
      if (ended && setup.configured()) {
        const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
        for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
      }
    } })
    // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
    const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
    const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
    const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects, health: this.runtimeHealth, lifetime: this.lifetime,
      configured: () => setup.configured(), closing: () => this.stopped.signal.aborted })
    this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready }, get deployment() { return setup.deployment },
      configured: () => setup.configured(), get setupProblem() { return setup.problem }, receive: trigger => passes.receive(trigger) }
    this.toolHost = { logger: console, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
      get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
      requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
      quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
    const github = githubKind(commands)
    this.sources.register(github)
    this.githubContext = this.context(github)
    this.ready = this.initialize()
    // Reads GitHub if it is due, so a first read does not wait for the background pass.
    void this.ready.then(() => this.tick()).catch(report)
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops, cancelling running reads. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  /** Tools are registered once per activation and scoped to the Sessions configured with them; each call resolves its Session here. */
  private toolNames: Record<'orchestrator' | 'worker', string[]> = { orchestrator: [], worker: [] }
  private registerTools(): void {
    const placeholder = { id: '' } as Ticket
    const roles = { orchestrator: mainTools(this.toolHost, { id: MASTER_ID }), worker: executorTools(this.toolHost, placeholder) }
    this.toolNames = { orchestrator: roles.orchestrator.map(tool => tool.name), worker: roles.worker.map(tool => tool.name) }
    const names = [...new Set([...this.toolNames.orchestrator, ...this.toolNames.worker])]
    const describe = new Map<string, Tool>([...roles.worker, ...roles.orchestrator].map(tool => [tool.name, tool]))
    this.disposers.push(this.ctx.weftManagedSessions.scopeTools(names))
    for (const name of names) {
      const tool = describe.get(name)!
      this.disposers.push(this.ctx.tools.register(defineTool({ name, description: tool.description, parameters: toolParameters(tool.schema) as never,
        output: { schema: { type: 'object', additionalProperties: true } as never, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        execute: async (args: unknown, execution: { signal: AbortSignal }) => {
          const value = await this.toolFor(name).execute(tool.schema.parse(args) as never, execution.signal)
          this.drive()
          // The sandbox takes JSON only; tools may leave optional fields undefined.
          return JSON.parse(JSON.stringify(value ?? {})) as never
        } }) as never))
    }
  }
  /** The tool named `name` as the calling Session may run it: a worker for its own ticket, the main Session for the whole. */
  private toolFor(name: string): Tool {
    const caller = this.ctx.sessionController.callerSessionId()
    const ticketId = caller === undefined ? undefined : ticketOfSessionId(caller)
    const ticket = ticketId === undefined ? undefined : this.store.tickets.get(ticketId)
    const available = caller === MASTER_ID ? mainTools(this.toolHost, { id: MASTER_ID }) : ticket ? executorTools(this.toolHost, ticket) : []
    const tool = available.find(item => item.name === name)
    if (!tool) throw new Error('This tool belongs to another dsh-superagent Session')
    return tool
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the panel.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    // The Source reads from when it was set up, which a first delivery must not move past what it announces.
    if (this.store.get(KV.github.since) === undefined) this.store.set(KV.github.since, now())
    this.registerTools()
    this.disposers.push(this.ctx.weftSessionEvents.onTurnEnded(event => this.turnEnded(event.sessionId)))
    await this.sessions.ensure(MASTER_ID, this.store.settings().executor.directory, 'dsh-superagent orchestrator', 'orchestrator').catch(async (error: unknown) => {
      // The root directory is created on first use, as a Session opens only in a directory that exists.
      await this.ctx.fs.writeText(await this.ctx.fs.resolve(`${this.store.settings().executor.directory}/.superagent`), 'dsh-superagent\n')
      await this.sessions.ensure(MASTER_ID, this.store.settings().executor.directory, 'dsh-superagent orchestrator', 'orchestrator').catch(() => { throw error })
    })
    if (this.stopped.signal.aborted) return
    this.executor.resume()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    this.drive()
  }
  /** A turn-end hint; the worker's log says what happened. */
  private async turnEnded(sessionId: string): Promise<void> {
    await this.ready
    if (sessionId !== MASTER_ID) await this.executor.turnEnded(sessionId)
    this.drive()
    await this.settled()
  }
  /** Runs what is due now and what comes due within the window of this wake; the next wake runs the rest from the Store. */
  drive(): Promise<void> {
    return this.driving ??= (async () => {
      const end = Date.now() + DRIVE_WINDOW_MS
      try {
        for (;;) {
          await this.passes.pump()
          await this.passes.idle()
          const due = this.effects.nextDue()
          if (due === undefined || due > end || this.stopped.signal.aborted) return
          await new Promise(resolve => setTimeout(resolve, Math.min(DRIVE_STEP_MS, Math.max(50, due - Date.now()))))
        }
      } catch (error) {
        this.runtimeHealth.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() })
      } finally { this.driving = undefined }
    })()
  }
  /** Waits for the current drive, so a Host request keeps the environment awake until it is done. */
  settled(): Promise<void> { return this.driving ?? Promise.resolve() }
  /** The background pass and a webhook: read GitHub, find lost turn ends, and run what is due. */
  async tick(force = false): Promise<void> {
    await this.ready
    // A check that failed for a passing reason, such as GitHub being unreachable, is tried again here.
    if (!this.configured()) {
      if (await this.setup.run(this.store.settings())) this.setup.restart()
      else this.githubContext.report('github', health('paused', 'setupPending'))
      return
    }
    await pollDue(this.githubContext, this.lifetime, force)
    await this.executor.reconcile()
    await this.drive()
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, get health() { return runtime.health }, machine, masterId, ready, sourceLinks,
      secrets: () => ({ githubToken: !!this.config.githubToken, webhookSecret: !!this.config.webhookSecret }), managementKey: () => this.config.managementKey, webhookSecret: () => this.config.webhookSecret, wake: () => this.tick(true), settled: () => this.drive(),
      get deployment() { return setup.deployment }, get setupProblem() { return setup.problem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog({}) as never }
  }
  /** Stops reads; the Sessions themselves live on, and the next activation picks up from the Store. */
  async stop(): Promise<void> {
    this.stopped.abort()
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    await this.passes.stop()
    await this.effects.drain()
  }
}
export { key, KV, workerSessionId }
