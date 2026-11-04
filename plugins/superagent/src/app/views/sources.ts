/** Source status view: health, 24-hour trigger counts, and recently filtered or dropped messages per Source instance. */
import { threadKey } from '../../core/index.ts'
import type { Deployment } from '../../deployment.ts'
import type { Health } from '../../sources/host.ts'
import type { SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { dayAgo, snapshot, type ViewHost } from './records.ts'
import { preview } from './text.ts'

export type HealthMap = Record<string, Health>
/** Resolves health entries for a Source instance, treating stale `sourceOff` entries on an enabled Source as `starting`. */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kind(instance.id)
  const starting: Health = { state: 'starting', detail: '' }
  const parts = (kind?.health ?? []).map(name => {
    const entry = health[name]
    return { name, ...(!entry || (instance.enabled && entry.code === 'sourceOff') ? starting : entry) }
  })
  const active = kind?.type ? parts.filter(part => part.name.endsWith(':webhook') ? instance.config.webhook : part.name.endsWith(':feed') ? instance.config.feed : true) : parts
  return { id: instance.id, title: instance.name ? {zh: instance.name, en: instance.name} : kind?.title ?? { zh: instance.id, en: instance.id }, health: active.length ? active : parts }
}
export interface SetupState {
  /** Resolved deployment facts; undefined while waiting for initial setup. */
  deployment?: Deployment | undefined
  /** Setup failure that stops all Sources. */
  problem?: SetupProblem | undefined
  /** Feishu bot check failure that pauses only the Feishu Source. */
}
export const problemOf = (id: string, setup: SetupState) => (setup.problem?.place === id ? setup.problem : undefined)
/** Source lifecycle state in priority order: missing kind, disabled, setup/part error, blocked on global setup, starting, paused, or ready. */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
export function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
  if (['repositoryUnset', 'agentTokenUnset'].includes(problemOf(instance.id, setup)?.code ?? '')) return 'setup'
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  if (parts.some(part => part.state === 'starting')) return 'starting'
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  const { store, sources } = host
  const view = snapshot(host)
  const since = dayAgo()
  const stats = store.read.triggerStats(since)
  const filtered = (source: string) => store.read.triggers({ source, filtered: true }, 0, 5).items.filter(trigger => trigger.at >= since)
    .map(trigger => ({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human), preview: preview(trigger.text, 120),
      reason: store.triggers.disposition(trigger.id)?.filtered }))
  const dropped = droppedReplies(host)
  return sources.instances().map(instance => {
    const { health: parts, ...named } = sourceHealth(sources, instance, health)
    const problem = problemOf(instance.id, setup)
    return { ...named, installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
      ...problem ? { problem } : {}, stats: stats[instance.id] ?? { received: 0, filtered: 0, lastAt: '' }, filtered: filtered(instance.id),
      dropped: dropped.filter(item => item.channel.source === instance.id) }
  })
}
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** Replies dropped in the last 24 hours, enriched with their associated ticket and thread. */
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // Fetch the exact 24-hour dropped count so this list's length matches the overview's `dropped` metric.
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    const { triggerId } = links(item.channel)
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}
