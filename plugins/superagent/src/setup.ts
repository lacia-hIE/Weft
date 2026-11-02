/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github'
export const SETUP_PROBLEMS = {
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentTokenUnset: ['deployment', 'The agent\'s GitHub token is not set.'],
  agentTokenRejected: ['deployment', 'GitHub rejected the agent\'s token.'],
  agentTokenFailed: ['deployment', 'The agent\'s token could not be checked.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when the token or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
