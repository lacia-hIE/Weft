/** Core startup is independent of optional GitHub account verification. Failures belong to that Source. */
import { SETUP_FIELDS, resolveDeployment, type Deployment, type Machine } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

/** Whether a settings change touches what setup reads, which takes effect by restarting. */
export function setupChanged(before: Settings, after: Settings): boolean {
  const fields = (settings: Settings, kind: string) => JSON.stringify([settings.sources[kind]?.enabled ?? false, (SETUP_FIELDS[kind] ?? []).map(field => settings.sources[kind]?.config[field])])
  return Object.keys(SETUP_FIELDS).some(kind => fields(before, kind) !== fields(after, kind))
}

export class Setup {
  private generation = 0
  private initialized = false
  private resolved?: Deployment | undefined
  problem?: SetupProblem | undefined
  constructor(private readonly host: { machine: Machine; token: () => string; lifetime: AbortSignal; restart: () => void }) {}
  configured(): boolean { return this.initialized }
  githubConfigured(): boolean { return this.resolved !== undefined }
  get githubDeployment(): Deployment | undefined { return this.resolved }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error('GitHub Source is not configured; use the selected execution environment for repository access')
    return this.resolved
  }
  /** Re-reads the account and repository, recording a `SetupError` in `problem`; returns whether setup succeeded. */
  async run(settings: Settings): Promise<boolean> {
    const generation = ++this.generation
    this.initialized = true
    const github = settings.sources.github
    if (!github?.enabled) { this.resolved = undefined; this.problem = undefined; return true }
    try {
      const resolved = await resolveDeployment(this.host.machine, github.config, this.host.token(), this.host.lifetime)
      if (generation !== this.generation) return true
      this.resolved = resolved
      this.problem = undefined
      return true
    } catch (error) {
      if (generation !== this.generation) return true
      if (!(error instanceof SetupError)) throw error
      this.resolved = undefined
      this.problem = error.problem
      return true
    }
  }
  /** Checks a candidate's account and repository before it is saved. */
  async checkAccounts(_block: string, candidate: Settings): Promise<void> {
    if (candidate.sources.github?.enabled) await resolveDeployment(this.host.machine, candidate.sources.github.config, this.host.token(), this.host.lifetime)
  }
  refresh(settings: Settings): void {void this.run(settings).catch(error => console.warn('GitHub Source:', String(error)))}
  /** Saved Source settings that change the account or repository take effect by restarting the plugin. */
  restart(): void { queueMicrotask(this.host.restart) }
  check(): void { this.restart() }
}
