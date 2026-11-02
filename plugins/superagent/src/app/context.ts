/** Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions. */
import { GITHUB_SKILL, PROMPT_FILES } from './prompt-files.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
export { textPage } from './cards.ts'

/** A built-in prompt: source files hold one sentence per line, which reads as one paragraph, with blank lines between paragraphs. */
export function promptFile(name: string): string {
  const text = PROMPT_FILES[name]
  if (!text?.trim()) throw new Error(`Missing packaged prompt: ${name}`)
  return text.replaceAll('\r\n', '\n').trim().split(/\n(?:[ \t]*\n)+/).map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
const skill = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(GITHUB_SKILL.replaceAll('\r\n', '\n'))
if (!skill) throw new Error('Invalid packaged GitHub skill')

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
export const sharedPrompt = promptFile('shared')
export const masterPrompt = promptFile('orchestrator')
export const workerPrompt = promptFile('worker')
/** Built-in policy sections referenced by role prompts; a team may override them. */
export const guides: Readonly<Record<string, string>> = Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work']
  .map(name => [name, promptFile(name)]))
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
export const sourceSkills: Readonly<Record<'github', string>> = { github: skill[3]! }
export const cliNotes = promptFile('cli')
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
export const teamDefaults = {
  communication: promptFile('team/communication'), scope: promptFile('team/scope'), delivery: promptFile('team/delivery'),
}

export const mainAdmissionPolicy = promptFile('admission')

const handoff = { shared: promptFile('handoff'), orchestrator: promptFile('handoff-orchestrator'), worker: promptFile('handoff-worker') }
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`

export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
export function transcriptEntry(event: SessionEvent) {
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  const message = event.type === 'user/message' ? event.data : event.data.message
  return { type: event.type, message: { role: message.role, content: message.content.filter(block => block.type !== 'reasoning') } }
}
