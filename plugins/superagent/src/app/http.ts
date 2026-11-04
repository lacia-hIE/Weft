/** Management routes for the web panel, under a key its entry's configuration holds, and the verified repository webhook. */
import type { HostContext } from './runtime.ts'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import { deliveryOf, type Delivery } from '../sources/github.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import {EVENT_TYPES, type RepositoryEvents} from '../sources/repository-events.ts'
import {CollaborationConflict, type Collaboration} from './collaboration.ts'
import { ExecutorRequestError, type RemoteExecutor } from '../executor/remote.ts'

export interface HttpHost {
  readonly repositoryEvents?: RepositoryEvents
  sourceSecret?(id: string, name: 'webhook' | 'token' | 'feed'): string
  sourceSecrets?(): Record<string, {webhook: boolean; token: boolean; feed: boolean}>
  readonly collaboration?: Collaboration
  appendRequest?(id: string, input: unknown): import('./api.ts').ApiResponse<'POST requests'>
  submitRequest?(input: unknown): import('./api.ts').ApiResponse<'POST requests'>
  readonly remote?: RemoteExecutor
  readonly store: Store
  /** Links resolved since startup, used by search. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'> & {refreshMain?(): Promise<void>}
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment | undefined
  readonly setupProblem?: SetupProblem | undefined
  configured(): boolean
  /** Whether each write-only credential holds a value; the panel never reads the values. */
  secrets(): { githubToken: boolean; webhookSecret: boolean }
  /** The key the panel sends; empty until the panel wrote one. */
  managementKey(): string
  webhookSecret(): string
  /** Reads GitHub at once and runs what that brings. */
  /** Reads what a verified webhook delivery names; see `Runtime.wake`. */
  wake(delivery: Delivery): Promise<void>
  /** Runs what a management operation left due. */
  settled(): Promise<void>
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
/** The parts of the Host's request and response that the routes use. */
interface HttpRequest extends AsyncIterable<Uint8Array> { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }
interface HttpResponse { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
async function readBytes(req: HttpRequest, maxBytes: number): Promise<Uint8Array> {
  let size = 0; const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
async function readBody(req: HttpRequest, maxBytes = 128 * 1024): Promise<unknown> {
  const bytes = await readBytes(req, maxBytes)
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: HttpResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
const header = (req: HttpRequest, name: string): string => { const value = req.headers[name]; return typeof value === 'string' ? value : '' }
/** Compares in time independent of where two strings differ. */
function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ (b[index] ?? 0)
  return difference === 0
}
/** Whether `signature` is GitHub's `sha256=` HMAC of the raw body under the configured secret. */
export async function verifiedWebhook(secret: string, body: Uint8Array, signature: string): Promise<boolean> {
  if (!secret) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body as BufferSource))
  return same(`sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`, signature)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof ExecutorRequestError) return [error.status, { error: error.message }]
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof CollaborationConflict || error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.deployment
  return {
    machine: machineView(runtime.machine), secrets: runtime.secrets(), sourceSecrets: runtime.sourceSecrets?.() ?? {}, problem: null as SetupProblem | null, githubProblem: runtime.setupProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, ...(settings.executor.executorId ? {defaultExecutorId: settings.executor.executorId} : {}), paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, executionComputer: runtime.remote?.status(id), environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'POST requests': async ({ body }) => {
      if (!runtime.submitRequest) throw new RouteError(400, 'User requests are unavailable')
      return runtime.submitRequest(await body())
    },
    'POST requests/:id/messages': async ({ params, body }) => {
      if (!runtime.appendRequest) throw new RouteError(400, 'User requests are unavailable')
      return runtime.appendRequest(params.id, await body())
    },
    'GET collaboration': () => runtime.collaboration?.view() ?? {revision: 0, at: '', origin: 'panel', notes: [], history: []},
    'PUT collaboration': async ({body}) => {
      if (!runtime.collaboration) throw new RouteError(400, 'Collaboration notes are unavailable')
      const saved = runtime.collaboration.replace(await body())
      await runtime.sessions.refreshMain?.()
      return saved
    },
    'POST sources': async ({body}) => {
      const input = z.object({kind: z.enum(EVENT_TYPES), name: z.string().trim().min(1).max(80)}).strict().parse(await body())
      if (runtime.sources.instances().length >= 48) throw new RouteError(400, 'At most 48 Sources may be configured')
      const id = runtime.sources.create(input.kind)
      await runtime.settings.save(`source:${id}`, {kind: input.kind, name: input.name, enabled: false, config: {}}, 0, 'panel')
      return {id}
    },
    'GET executors': () => runtime.remote?.list() ?? [],
    'POST executors': async ({ body }) => {
      const input = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(await body())
      if (!runtime.remote) throw new RouteError(400, 'Remote execution is unavailable')
      return runtime.remote.create(input.name)
    },
    'POST executors/:id/revoke': ({ params }) => { runtime.remote?.revoke(params.id); return { revoked: true } },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime)),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
/** A delivery names what to look at; what GitHub holds says what happened, so the Source reads it as on any pass. */
const WEBHOOK_SETTLE_MS = 2000, WEBHOOK_REPLY_MS = 8000
export function registerHttp(ctx: HostContext, runtime: HttpHost): () => void {
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({kind: 'prefix', path: '/source-events', handler: async (req: HttpRequest, res: HttpResponse) => {
      try {
        if (req.method !== 'POST') {json(res, 405, {error: 'POST required'});return}
        await runtime.ready
        const match = /^\/source-events\/(src-[a-f0-9-]{36})$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        const id = match?.[1], instance = id && runtime.sources.instance(id)
        if (!id || !instance || !runtime.repositoryEvents || !EVENT_TYPES.includes(instance.kind as never)) {json(res, 404, {error: 'Source not found'});return}
        const secret = runtime.sourceSecret?.(id, 'webhook') ?? '', bytes = await readBytes(req, 512 * 1024)
        const verified = instance.kind === 'github-webhook' ? await verifiedWebhook(secret, bytes, header(req, 'x-hub-signature-256'))
          : instance.kind === 'gitlab' && !!secret && same(secret, header(req, 'x-gitlab-token'))
        if (!verified) {json(res, 401, {error: 'Unverified delivery'});return}
        const delivery = header(req, 'x-github-delivery') || header(req, 'x-gitlab-event-uuid') || header(req, 'x-gitlab-webhook-uuid')
        if (!delivery || delivery.length > 200) {json(res, 400, {error: 'Delivery identity required'});return}
        await runtime.repositoryEvents.webhook(id, instance.kind as 'github-webhook' | 'gitlab' | 'feed', JSON.parse(new TextDecoder().decode(bytes)), delivery)
        json(res, 202, {accepted: true});await runtime.settled()
      } catch (error) {json(res, ...failure(error))}
    }}),
    ctx.webServer.register({ kind: 'exact', path: '/github', handler: async (req: HttpRequest, res: HttpResponse) => {
      try {
        const body = await readBytes(req, 1 << 20)
        if (!await verifiedWebhook(runtime.webhookSecret(), body, header(req, 'x-hub-signature-256'))) { json(res, 401, { error: 'Unverified delivery' }); return }
        // GitHub gives up after ten seconds, and a slow read is finished by the next pass.
        let payload: unknown
        try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { payload = undefined /* A form-encoded or empty delivery names nothing; the scheduled round reads. */ }
        const wake = new Promise(resolve => setTimeout(resolve, WEBHOOK_SETTLE_MS)).then(() => runtime.wake(deliveryOf(payload))).catch(() => { /* Reported in the Source's health; the next pass reads again. */ })
        await Promise.race([wake, new Promise(resolve => setTimeout(resolve, WEBHOOK_REPLY_MS))])
        json(res, 202, { accepted: true })
      } catch (error) { json(res, ...failure(error)) }
    } }),
    ctx.webServer.register({ kind: 'prefix', path: '/executor', handler: async (req: HttpRequest, res: HttpResponse) => {
      try {
        if (req.method !== 'POST' || header(req, 'origin')) { json(res, 403, { error: 'Device requests only' }); return }
        const match = /^\/executor\/([a-f0-9-]{36})\/(pair|sync|tool)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        if (!match || !runtime.remote) { json(res, 404, { error: 'Unknown executor operation' }); return }
        const id = match[1]!, operation = match[2]!
        const token = header(req, 'authorization').replace(/^Bearer /, '')
        if (operation === 'pair') { json(res, 200, await runtime.remote.pair(id, token)); return }
        await runtime.remote.authenticate(id, token)
        await runtime.ready
        if (!runtime.configured()) { json(res, 503, { error: 'Superagent setup is incomplete' }); return }
        const body = await readBody(req, 512 * 1024)
        json(res, 200, operation === 'sync' ? runtime.remote.sync(id, body) : await runtime.remote.call(id, body, AbortSignal.timeout(30_000)))
      } catch (error) { json(res, ...failure(error)) }
    } }),
    ctx.webServer.register({ kind: 'prefix', path: '/api', handler: async (req: HttpRequest, res: HttpResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const key = runtime.managementKey()
      // The route is public: only the holder of the key the panel saved through the Host's Settings may use it.
      if (!key || !same(`Bearer ${key}`, header(req, 'authorization'))) { json(res, 401, { error: 'Management key required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
        await runtime.settled()
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
