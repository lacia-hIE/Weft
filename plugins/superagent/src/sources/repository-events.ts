/** Repository event Sources with independent webhook and feed transports; no git execution configuration. */
import {XMLParser, XMLValidator} from '../vendor/xml-parser.mjs'
import {z} from 'zod'
import {key, isoTime, type Trigger} from '../core/index.ts'
import {family} from '../kv.ts'
import type {Store} from '../app/store.ts'
import type {SourceKind, FieldSpec} from './kind.ts'
import type {SourceHost} from './host.ts'

export const EVENT_TYPES = ['github-webhook', 'gitlab', 'feed'] as const
export type EventType = typeof EVENT_TYPES[number]
export const EventConfig = z.object({
  repository: z.string().trim().max(300).refine(value => !value || /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(value), 'Use a repository path such as team/repository').default(''),
  site: z.string().trim().max(1000).default(''),
  webhook: z.boolean().default(true), feed: z.boolean().default(false),
  mention: z.string().trim().max(100).default(''), reply: z.boolean().default(false),
  intervalSeconds: z.number().int().min(60).max(3600).default(300),
}).strict()
type Config = z.infer<typeof EventConfig>
interface FeedState {fingerprint?: string; initialized: boolean; seen: string[]; next: number; etag?: string; modified?: string}
const cursors = family<FeedState>('source-feed:')
const deliveries = family<string[]>('source-deliveries:')
const observations = family<string[]>('source-observations:')
const replyReceipts = family<'pending' | 'sent', [string, string]>('source-reply:')
const resource = (raw: string) => {try {const url = new URL(raw);url.search = '';return url.href}catch {return raw}}
const thread = (raw: string) => resource(raw).split('#')[0]!
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const origin = (config: Config, type: EventType) => {
  const url = new URL(config.site || (type === 'gitlab' ? 'https://gitlab.com' : 'https://github.com'))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS site origin')
  return url.origin
}
const https = (raw: string) => {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS subscription address')
  return url
}
async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();if (!reader) return ''
  const chunks: Uint8Array[] = [];let size = 0
  try {
    for (;;) {const part = await reader.read();if (part.done) break;size += part.value.length;if (size > 512 * 1024) throw new Error('Subscription exceeds 512 KiB');chunks.push(part.value)}
  } finally {await reader.cancel().catch(() => {})}
  const bytes = new Uint8Array(size);let offset = 0;for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.length}
  return new TextDecoder().decode(bytes)
}
export function feedEntries(xml: string): {id: string; title: string; body: string; url: string; at: string}[] {
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid RSS or Atom document')
  const parsed = new XMLParser({ignoreAttributes: false, processEntities: false, parseTagValue: false}).parse(xml)
  const atom = parsed.feed, rss = parsed.rss?.channel
  if (!atom && !rss) throw new Error('Expected an RSS or Atom feed')
  return list<any>(atom?.entry ?? rss?.item).slice(0, 200).map(item => {
    const links = list<any>(item.link)
    const link = atom ? links.find(value => !value['@_rel'] || value['@_rel'] === 'alternate')?.['@_href'] : text(item.link)
    const url = text(link), title = text(item.title?.['#text'] ?? item.title), body = text(item.summary?.['#text'] ?? item.summary ?? item.description ?? item.content?.['#text'] ?? item.content)
    const at = text(item.updated ?? item.published ?? item.pubDate), guid = text(item.id ?? item.guid?.['#text'] ?? item.guid) || url
    return {id: key(guid, at, title, body), title: title.slice(0, 500), body: body.slice(0, 16000), url, at: Number.isNaN(Date.parse(at)) ? new Date().toISOString() : isoTime(at)}
  })
}
export interface EventHost {
  store: Store
  context(id: string): ReturnType<SourceHost['context']>
  secret(id: string, name: 'webhook' | 'token' | 'feed'): string
}
export class RepositoryEvents {
  constructor(private readonly host: EventHost) {}
  kind(id: string, type: EventType): SourceKind<Config> {
    const events = this
    return {
      kind: id, type, defaultEnabled: false,
      get title() {const name = events.host.store.settings().sources[id]?.name || (type === 'github-webhook' ? 'GitHub' : type === 'gitlab' ? 'GitLab' : 'RSS / Atom');return {zh: name, en: name}},
      description: {zh: '独立接收 Webhook 或 RSS/Atom，按来源策略评估事件。仓库操作由执行器负责。', en: 'Receive webhooks or RSS/Atom independently. Source Policy evaluates events; Executors own repository operations.'},
      schema: type === 'feed' ? EventConfig.extend({webhook: z.boolean().default(false), feed: z.boolean().default(true)}) : EventConfig, health: [`${id}:webhook`, `${id}:feed`],
      fields: ([
        {key: 'repository', type: 'text', label: {zh: '监听范围（仓库路径）', en: 'Repository scope'}, hint: {zh: 'Webhook 必填，例如 team/repository；清空可保存为草稿。', en: 'Required for webhooks, e.g. team/repository. Clear to save an unconfigured draft.'}},
        {key: 'site', type: 'text', label: {zh: '平台地址（可选）', en: 'Site origin (optional)'}},
        {key: 'webhook', type: 'switch', label: {zh: '接收 Webhook', en: 'Receive webhooks'}},
        {key: 'feed', type: 'switch', label: {zh: '订阅 RSS / Atom', en: 'Subscribe to RSS / Atom'}},
        {key: 'mention', type: 'text', label: {zh: '直接请求时提及的账号', en: 'Account mentioned in direct requests'}},
        {key: 'reply', type: 'switch', label: {zh: '通过平台回复（需 API 凭据）', en: 'Reply through the platform (requires API credentials)'}},
        {key: 'intervalSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: {zh: '订阅检查间隔（秒）', en: 'Feed polling interval (seconds)'}},
      ] as FieldSpec[]).filter(field => type !== 'feed' || ['feed', 'intervalSeconds'].includes(field.key)),
      scope: ({meta}, config) => meta.repository && String(meta.repository).toLowerCase() !== config.repository.toLowerCase() ? {listened: false, reason: 'repository_changed'} : {listened: true, observed: true, row: 'activity'},
      policy: {
        schema: z.object({allowed: z.array(z.object({id: z.string().trim().min(1).max(100)}).strict()).default([])}).strict(),
        fields: [{key: 'allowed', type: 'rows', label: {zh: '可发起明确请求的账号', en: 'Accounts allowed to originate requests'}, columns: [{key: 'id', type: 'text', label: {zh: '平台账号', en: 'Platform account'}}]}],
        explicit: {zh: '经过验证的 Webhook 中，名单里的账号直接提及智能体。RSS/Atom 只形成观察型候选。', en: 'An allowed account mentions the agent in a verified webhook. Feed entries are observational candidates only.'},
        rows: () => [{id: 'activity', label: {zh: '来源事件', en: 'Source events'}, note: {zh: '全部', en: 'All'}, cells: {listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true}}],
      },
      ...(type !== 'feed' && this.host.secret(id, 'token') ? {threadContext: {
        messageId: (trigger: Trigger) => text(trigger.meta.messageId) || trigger.id,
        read: (trigger: Trigger, part: 'root' | 'parent' | 'thread', cursor: string | undefined, _config: Config, signal?: AbortSignal) => this.readContext(id, type, trigger, part, cursor, signal),
      }} : {}),
      channel: {link: address => ({url: address.url ?? '', label: {zh: '原始讨论', en: 'Original discussion'}}), send: (message, signal) => this.reply(id, type, message.id, message.channel.address, message.text, signal)},
      poll: async (_host, signal) => this.poll(id, type, signal),
    }
  }
  async webhook(id: string, type: EventType, raw: unknown, delivery: string): Promise<void> {
    const ctx = this.host.context(id), config = ctx.config<Config>(id)
    if (!config?.webhook || !config.repository) throw new Error('Webhook Source is disabled or awaiting repository scope')
    const payload = object(raw), github = type === 'github-webhook'
    if (type === 'feed') throw new Error('Use a repository Source for webhooks')
    const repository = github ? text(payload.repository?.full_name) : text(payload.project?.path_with_namespace)
    if (repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Webhook repository does not match the Source scope')
    const subject = object(github ? payload.issue ?? payload.pull_request ?? payload.workflow_run ?? payload.check_run ?? payload.check_suite : payload.object_attributes ?? payload)
    const comment = object(github ? payload.comment ?? payload.review : payload.object_kind === 'note' ? subject : undefined)
    const number = text(github ? subject.number ?? payload.number : subject.noteable_iid ?? subject.iid)
    const url = text(comment.html_url ?? comment.url ?? subject.html_url ?? subject.url) || `${origin(config, type)}/${repository}`
    const address = github ? number ? `issues/${number}/comments` : '' : number ? `${subject.noteable_type === 'Issue' || payload.object_kind === 'issue' ? 'issues' : 'merge_requests'}/${number}/notes` : ''
    const author = object(github ? payload.sender : payload.user)
    const body = text(comment.body ?? comment.note ?? subject.body ?? subject.description ?? subject.note)
    const title = text(subject.title ?? payload.ref ?? payload.object_kind)
    const actor = text(author.login ?? author.username), human = !!actor && !/\[bot\]$/.test(actor) && author.type !== 'Bot' && author.bot !== true
    const at = text(comment.updated_at ?? subject.updated_at ?? subject.created_at) || new Date().toISOString()
    const version = text(comment.updated_at ?? subject.updated_at ?? subject.sha ?? payload.after) || delivery
    const event = text(payload.action ?? subject.action ?? payload.object_kind) || 'activity'
    const trigger: Trigger = {id: key(id, url, event, version), source: id, threads: [{source: id, id: thread(url)}], actor: {source: id, id: actor}, human,
      ...(config.mention && new RegExp(`(^|[^\\w@])@${config.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(body) && human ? {addressed: 'mention' as const} : {}),
      at: Number.isNaN(Date.parse(at)) ? new Date().toISOString() : isoTime(at), text: `${title}\n${body}`.slice(0, 24000), url,
      ...(config.reply && address ? {channel: {source: id, thread: `${id}:${thread(url)}`, address: {path: address, url}}} : {}),
      meta: {repository, number, messageId: text(comment.id) || '', resource: github ? payload.pull_request || payload.issue?.pull_request ? 'pulls' : 'issues' : payload.object_kind === 'issue' || subject.noteable_type === 'Issue' ? 'issues' : 'merge_requests', provider: type, event, title, transport: 'webhook'}}
    const seen = this.host.store.get(deliveries(id)) ?? []
    if (seen.includes(delivery)) return
    this.host.store.atomic(() => {
      ctx.receive(trigger);this.host.store.set(deliveries(id), [delivery, ...seen].slice(0, 500))
      this.host.store.set(observations(id), [key(resource(url), trigger.at), ...(this.host.store.get(observations(id)) ?? [])].slice(0, 1000))
    })
    ctx.report(`${id}:webhook`, {state: 'ready', detail: 'Webhook event received', at: new Date().toISOString()})
  }
  async poll(id: string, type: EventType, signal: AbortSignal): Promise<void> {
    const ctx = this.host.context(id), config = ctx.config<Config>(id)
    if (!config) {for (const part of ['webhook', 'feed']) ctx.report(`${id}:${part}`, {state: 'paused', detail: 'Off'});return}
    const hookReady = config.webhook && !!config.repository && !!this.host.secret(id, 'webhook')
    ctx.report(`${id}:webhook`, {state: hookReady ? 'ready' : 'paused', detail: hookReady ? 'Waiting for verified webhook delivery' : config.webhook ? 'Webhook needs repository scope and a shared secret' : 'Off'})
    if (!config.feed) {ctx.report(`${id}:feed`, {state: 'paused', detail: 'Off'});return}
    const subscription = this.host.secret(id, 'feed'), fingerprint = key(subscription)
    let state = this.host.store.get(cursors(id)) ?? {initialized: false, seen: [], next: 0}
    if (state.fingerprint !== fingerprint) state = {initialized: false, seen: [], next: 0, fingerprint}
    if (state.next > Date.now()) return
    try {
      const url = https(subscription)
      const response = await fetch(url, {redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: {
        accept: 'application/atom+xml, application/rss+xml, application/xml', ...(state.etag ? {'if-none-match': state.etag} : {}), ...(state.modified ? {'if-modified-since': state.modified} : {}),
      }})
      if (response.status === 304) {this.host.store.set(cursors(id), {...state, next: Date.now() + config.intervalSeconds * 1000});ctx.report(`${id}:feed`, {state: 'ready', detail: 'Subscription unchanged', at: new Date().toISOString()});return}
      if (!response.ok) throw new Error(`Subscription HTTP ${response.status}`)
      const entries = feedEntries(await bounded(response)), seen = new Set(state.seen), verified = new Set(this.host.store.get(observations(id)) ?? [])
      this.host.store.atomic(() => {
        if (state.initialized) for (const entry of [...entries].reverse()) if (!seen.has(entry.id)) {
          if (verified.has(key(resource(entry.url), entry.at))) continue
          if (config.repository && type !== 'feed') {
            let link: URL
            try {link = new URL(entry.url)} catch {continue}
            if (link.origin !== origin(config, type) || !link.pathname.toLowerCase().startsWith(`/${config.repository.toLowerCase()}/`)) continue
          }
          ctx.receive({id: key(id, entry.id), source: id, actor: {source: id, id: ''}, human: false, at: entry.at,
            threads: [{source: id, id: entry.url ? thread(entry.url) : entry.id}], text: `${entry.title}\n${entry.body}`, ...(entry.url ? {url: entry.url} : {}), meta: {transport: 'feed', provider: type, title: entry.title, ...(config.repository ? {repository: config.repository} : {})}})
        }
        this.host.store.set(cursors(id), {fingerprint, initialized: true, seen: [...new Set([...entries.map(entry => entry.id), ...state.seen])].slice(0, 1000), next: Date.now() + config.intervalSeconds * 1000,
          ...(response.headers.get('etag') ? {etag: response.headers.get('etag')!} : {}), ...(response.headers.get('last-modified') ? {modified: response.headers.get('last-modified')!} : {})})
      })
      ctx.report(`${id}:feed`, {state: 'ready', detail: state.initialized ? 'Subscription checked' : 'Subscription baseline saved; historical entries were not dispatched', at: new Date().toISOString()})
    } catch (error) {
      if (signal.aborted) return
      this.host.store.set(cursors(id), {...state, next: Date.now() + config.intervalSeconds * 1000})
      // Subscription URLs can carry credentials. Never include raw fetch errors or addresses in diagnostics.
      ctx.report(`${id}:feed`, {state: 'error', detail: error instanceof Error && /^Subscription HTTP \d+$/.test(error.message) ? error.message : 'Subscription could not be read; check the private address and authentication'})
    }
  }
  private async readContext(id: string, type: EventType, trigger: Trigger, part: 'root' | 'parent' | 'thread', cursor: string | undefined, signal?: AbortSignal) {
    const config = this.host.context(id).config<Config>(id), token = this.host.secret(id, 'token')
    if (!config || !token || trigger.source !== id || trigger.meta.repository !== config.repository) throw new Error('Source context is unavailable for this repository')
    const number = text(trigger.meta.number), page = cursor === undefined ? 1 : Number(cursor)
    if (!/^\d+$/.test(number) || !Number.isInteger(page) || page < 1 || page > 10) throw new Error('Invalid Source context reference')
    const github = type === 'github-webhook', site = origin(config, type), root = trigger.meta.resource === 'issues' ? 'issues' : github ? 'pulls' : 'merge_requests'
    const path = part === 'thread' ? github ? `issues/${number}/comments?per_page=50&page=${page}` : `${root}/${number}/notes?per_page=50&page=${page}` : `${root}/${number}`
    const endpoint = github ? `${site === 'https://github.com' ? 'https://api.github.com' : `${site}/api/v3`}/repos/${config.repository}/${path}` : `${site}/api/v4/projects/${encodeURIComponent(config.repository)}/${path}`
    const response = await fetch(endpoint, {redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]),
      headers: {'user-agent': 'weft-superagent', ...(github ? {authorization: `Bearer ${token}`} : {'private-token': token})}})
    if (!response.ok) throw new Error(`Source context HTTP ${response.status}`)
    const raw = JSON.parse(await bounded(response)), items = part === 'thread' ? list(raw) : [raw]
    const messages = items.map(item => {const row = object(item), user = object(row.user ?? row.author);return {
      id: text(row.id ?? row.number ?? row.iid), from: text(user.login ?? user.username), at: text(row.updated_at ?? row.created_at),
      text: [text(row.title), text(row.body ?? row.note ?? row.description)].filter(Boolean).join('\n').slice(0, 32000),
      ...(user.type === 'Bot' || user.bot === true ? {bot: true as const} : {}), ...(row.html_url || row.web_url ? {url: text(row.html_url ?? row.web_url)} : {}),
    }})
    return {messages, ...(part === 'thread' && items.length >= 50 && page < 10 ? {next: String(page + 1)} : {}), body: {messages, ...(part === 'parent' ? {notice: 'This Source provides the discussion root; a distinct reply parent is unavailable'} : {})}}
  }
  private async reply(id: string, type: EventType, messageId: string, address: Record<string, string>, body: string, signal?: AbortSignal): Promise<'sent' | 'gone'> {
    const config = this.host.context(id).config<Config>(id)
    if (!config?.reply || type === 'feed') return 'gone'
    const token = this.host.secret(id, 'token');if (!token) throw new Error('Source reply credentials are not configured')
    const site = origin(config, type), github = type === 'github-webhook'
    if (!/^(issues|merge_requests)\/\d+\/(comments|notes)$/.test(address.path ?? '')) throw new Error('Invalid Source reply address')
    const endpoint = github ? `${site === 'https://github.com' ? 'https://api.github.com' : `${site}/api/v3`}/repos/${config.repository}/${address.path}`
      : `${site}/api/v4/projects/${encodeURIComponent(config.repository)}/${address.path}`
    const receipt = replyReceipts(id, messageId), marker = `<!-- weft:${messageId} -->`, previous = this.host.store.get(receipt)
    if (previous === 'sent') return 'sent'
    const headers = {'content-type': 'application/json', 'user-agent': 'weft-superagent', ...(github ? {authorization: `Bearer ${token}`} : {'private-token': token})}
    const scoped = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)])
    if (previous === 'pending') {
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(`${endpoint}?per_page=100&page=${page}`, {redirect: 'error', headers, signal: scoped})
        if (!response.ok) throw new Error(`Source reply recovery HTTP ${response.status}`)
        const comments = await response.json() as {body?: string}[]
        if (!Array.isArray(comments)) throw new Error('Invalid Source reply recovery response')
        if (comments.some(comment => comment.body?.includes(marker))) {this.host.store.set(receipt, 'sent');return 'sent'}
        if (comments.length < 100) break
        if (page === 10) throw new Error('Earlier Source reply outcome is uncertain; inspect the conversation before retrying')
      }
    }
    this.host.store.set(receipt, 'pending')
    const response = await fetch(endpoint, {method: 'POST', redirect: 'error', signal: scoped,
      headers, body: JSON.stringify({body: `${body}\n\n${marker}`})})
    if (!response.ok) throw new Error(`Source reply HTTP ${response.status}`)
    this.host.store.set(receipt, 'sent')
    return 'sent'
  }
}
