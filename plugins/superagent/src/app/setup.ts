/** Resolves the target repository and the agent's GitHub account, tracking setup readiness for the panel and Sources. */
import { SETUP_FIELDS, resolveDeployment, type Deployment, type Machine } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

/** Whether a settings change touches what setup reads, which takes effect by restarting. */
export function setupChanged(before: Settings, after: Settings): boolean {
  const fields = (settings: Settings, kind: string) => JSON.stringify([settings.sources[kind]?.enabled !== false, (SETUP_FIELDS[kind] ?? []).map(field => settings.sources[kind]?.config[field])])
  return Object.keys(SETUP_FIELDS).some(kind => fields(before, kind) !== fields(after, kind))
}

export class Setup {
  private resolved?: Deployment | undefined
  problem?: SetupProblem | undefined
  constructor(private readonly host: { machine: Machine; token: () => string; lifetime: AbortSignal; restart: () => void }) {}
  configured(): boolean { return this.resolved !== undefined }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error('dsh-superagent is waiting for setup')
    return this.resolved
  }
  /** Re-reads the account and repository, recording a `SetupError` in `problem`; returns whether setup succeeded. */
  async run(settings: Settings): Promise<boolean> {
    const github = settings.sources.github
    try {
      this.resolved = await resolveDeployment(this.host.machine, github?.enabled === false ? {} : github?.config, this.host.token(), this.host.lifetime)
      this.problem = undefined
      return true
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.resolved = undefined
      this.problem = error.problem
      return false
    }
  }
  /** Checks a candidate's account and repository before it is saved. */
  async checkAccounts(_block: string, candidate: Settings): Promise<void> {
    await resolveDeployment(this.host.machine, candidate.sources.github?.config, this.host.token(), this.host.lifetime)
  }
  /** Saved Source settings that change the account or repository take effect by restarting the plugin. */
  restart(): void { queueMicrotask(this.host.restart) }
  check(): void { this.restart() }
}
