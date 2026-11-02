/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes {
  private stopped = false
  private pumping?: Promise<void> | undefined
  private pumpAgain?: Promise<void> | undefined
  constructor(private readonly host: PassesHost) {}
  stop(): Promise<unknown> {
    this.stopped = true
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
  }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    this.host.engine.evaluateDue()
  }
}
