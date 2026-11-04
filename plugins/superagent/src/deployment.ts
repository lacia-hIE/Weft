/** Plugin configuration and startup verification of the agent's GitHub token and repository. */
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { CliError, Commands } from './infra/commands.ts'
import { LIMITS } from './limits.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Native Settings form of the entry: secrets stay out of the panel's settings and of environment copies. */
export const Config = s.object({
  sourceSecrets: s.dict(s.string().role('secret')).default({}).description('Write-only credentials addressed by Source instance; never included in panel settings or Agent instructions.'),
  githubToken: s.string().role('secret').default('').description('Classic token of the agent\'s dedicated GitHub account, with the repo and notifications scopes.'),
  webhookSecret: s.string().role('secret').default('').description('Secret of the repository webhook that wakes the Source. Without it the Source polls only.'),
  managementKey: s.string().role('secret').default('').description('Written by the management panel; authorizes its requests.'),
  reconcileSeconds: s.number().min(60).max(3600).step(1).default(300).description('Seconds between background passes when nothing wakes the environment.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000).description('Largest saved prompt configuration, in characters.'),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10).description('Pages of thread context one assessment may read.'),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1).default(15000).description('Time limit of one context read during an assessment, in milliseconds.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  promptMaxChars: { get(): number }
  admissionContextMaxPages: { get(): number }
  admissionContextTimeoutMs: { get(): number }
}
export const machineOf = (config: DeploymentConfig): Machine => ({ promptMaxChars: { get: () => config.promptMaxChars },
  admissionContextMaxPages: { get: () => config.admissionContextMaxPages }, admissionContextTimeoutMs: { get: () => config.admissionContextTimeoutMs } })

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { login: string; noreply: string }
}
const GithubUser = z.looseObject({ login: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/), id: z.number().int().positive() })
const RepositoryAccess = z.looseObject({ full_name: z.string(), permissions: z.looseObject({ push: z.boolean() }).optional() })
/** Verify the agent token's identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, token: string, signal: AbortSignal): Promise<Deployment> {
  const { repository: remote } = GithubAccountsSchema.parse(github ?? {})
  if (!remote) throw new SetupError('repositoryUnset')
  if (!token) throw new SetupError('agentTokenUnset')
  const pending: Deployment = { ...machine, repository: remote, github: { login: '', noreply: '' } }
  const commands = new Commands(() => pending, () => token, signal)
  const agent = await commands.user(GithubUser).catch((error: unknown) => {
    if (error instanceof CliError && error.code !== 401) throw new SetupError('agentTokenFailed', { output: reason(error) })
    throw new SetupError('agentTokenRejected', { output: reason(error) })
  })
  const access = await commands.api(RepositoryAccess, '').catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  })
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const repository = access.full_name
  // Event reception needs repository reads, not git push or merge permission.
  return { ...machine, repository, github: { login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}
