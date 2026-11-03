/** GitHub REST client under the configured agent account, keeping the argument shape of `gh api` that the Source's reads are written in. */
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const TIMEOUT_MS = 30_000
/** One round of paginated reads stays well inside a Worker's subrequest budget. */
const MAX_PAGES = 10
/** Error thrown when a GitHub call fails, carrying GitHub's HTTP status as `code`; Sources inspect it to distinguish deleted conversations from retryable failures. */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
export interface Tally { skipped: number }
/** Requests sent through one deployment's client, and the rate limit GitHub reported with the latest response. */
export interface Meter { requests: number; remaining?: number; limit?: number }
/** A list read with a validator from the previous read: `unchanged` costs no rate limit. */
export type Listed<T> = { unchanged: true } | { unchanged: false; items: T[]; etag?: string }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
interface Request { method: string; headers: Record<string, string>; fields: Record<string, string>; include: boolean }
function parseFlags(flags: readonly string[]): Request {
  const request: Request = { method: 'GET', headers: {}, fields: {}, include: false }
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!
    if (flag === '--include') request.include = true
    else if (flag === '--method' || flag === '-X') request.method = flags[++index]!
    else if (flag === '-H' || flag === '--header') {
      const header = flags[++index]!, split = header.indexOf(':')
      request.headers[header.slice(0, split).trim()] = header.slice(split + 1).trim()
    } else if (flag === '-f' || flag === '--raw-field') {
      const field = flags[++index]!, split = field.indexOf('=')
      request.fields[field.slice(0, split)] = field.slice(split + 1)
      if (request.method === 'GET') request.method = 'POST'
    } else throw new Error(`Unsupported GitHub request flag: ${flag}`)
  }
  return request
}
/**
 * Calls GitHub with the deployment's agent token, timeouts and abort signals, restricted to the configured repository,
 * translating failures into CliError for Sources, MasterAssessor, Outbox and Settings.
 */
export class Commands {
  /** @param resolved - returns the resolved deployment setup, or throws while setup is still pending. */
  constructor(private readonly resolved: () => Deployment, private readonly token: () => string, private readonly signal: AbortSignal,
    /** Shared by every client derived with `withSignal`. */
    readonly meter: Meter = { requests: 0 }) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.token, AbortSignal.any([this.signal, signal]), this.meter) : this }
  /** Sends one REST request to `path` under api.github.com. */
  async fetch(path: string, { method, headers, fields }: Pick<Request, 'method' | 'headers' | 'fields'>): Promise<Response> {
    const body = method === 'GET' ? undefined : JSON.stringify(fields)
    const response = await fetch(`https://api.github.com/${path}`, { method, redirect: 'follow', signal: AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token()}`, 'user-agent': 'weft-superagent', 'x-github-api-version': '2022-11-28',
        ...body === undefined ? {} : { 'content-type': 'application/json' }, ...headers }, ...body === undefined ? {} : { body } })
    this.meter.requests++
    const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? NaN), limit = Number(response.headers.get('x-ratelimit-limit') ?? NaN)
    if (Number.isFinite(remaining)) this.meter.remaining = remaining
    if (Number.isFinite(limit)) this.meter.limit = limit
    if (response.ok) return response
    const text = await response.text().catch(() => '')
    let message = text.slice(0, 2000)
    try { message = (JSON.parse(text) as { message?: string }).message ?? message } catch { /* A non-JSON failure is kept as it came. */ }
    throw new CliError(`GitHub: ${message || response.statusText} (HTTP ${response.status})`, response.status)
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided,
   * or returning the raw text, preceded by its headers with `--include`, when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') {
      const request = parseFlags(rest)
      const response = await this.fetch(this.path(schema), request)
      const text = await response.text()
      return request.include ? `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${text}` : text
    }
    const [path = '', ...flags] = rest
    return schema.parse(await (await this.fetch(this.path(path), parseFlags(flags))).json())
  }
  /**
   * Fetches the pages of a GitHub API list within the configured repository, skipping items that fail schema validation.
   * @param field - the response property holding the list, for lists wrapped in an object such as `check_runs`.
   */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally, field?: string): Promise<T[]> {
    const listed = await this.listed(item, path, { ...tally ? { tally } : {}, ...field ? { field } : {} })
    return listed.unchanged ? [] : listed.items
  }
  /**
   * Fetches a list like `pages`; with the `etag` of an earlier read of the same path, an unchanged list answers
   * HTTP 304, which costs no rate limit. The result carries a validator only when the list fits one page.
   */
  async listed<T>(item: z.ZodType<T>, path: string, options: { tally?: Tally; field?: string; etag?: string } = {}): Promise<Listed<T>> {
    const items: unknown[] = []
    let next: string | undefined = this.path(path), etag: string | undefined
    for (let page = 0; next && page < MAX_PAGES; page++) {
      let response: Response
      try { response = await this.fetch(next, { method: 'GET', headers: page === 0 && options.etag ? { 'if-none-match': options.etag } : {}, fields: {} }) }
      catch (error) { if (page === 0 && options.etag && error instanceof CliError && error.code === 304) return { unchanged: true }; throw error }
      const body: unknown = await response.json()
      items.push(...z.array(z.unknown()).parse(options.field ? (body as Record<string, unknown> | null)?.[options.field] : body))
      next = /<https:\/\/api\.github\.com\/([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
      if (page === 0 && !next) etag = response.headers.get('etag') ?? undefined
    }
    return { unchanged: false, items: validItems(item, items, options.tally), ...etag ? { etag } : {} }
  }
  /** Reads the agent's account, which is not under the repository. */
  async user<T>(schema: z.ZodType<T>): Promise<T> { return schema.parse(await (await this.fetch('user', { method: 'GET', headers: {}, fields: {} })).json()) }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
}
