/** The authenticated panel fixes placement before Eval; the model cannot change it. */
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { REQUEST_OWNER, REQUEST_SOURCE } from '../sources/request.ts'
import { ExecutorRequestError, type RemoteExecutor } from '../executor/remote.ts'
import type { Store } from './store.ts'

export const RequestSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(32000),
  executorId: z.string().uuid().nullable(), placement: z.enum(['fixed', 'auto']).default('fixed'), projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable().default(null),
}).strict()
export type UserRequest = z.input<typeof RequestSchema>
export interface RequestTarget { executorId: string | null; projectId: string | null; placement?: 'fixed' | 'auto' }
export const requestChoices = family<{executorId: string | null}>('request-placement:')
export const requestTargets = family<RequestTarget>('request-target:')

export function submitRequest(host: { store: Store; remote?: RemoteExecutor; receive(trigger: Trigger): ReceiveResult }, raw: unknown, conversationId?: string) {
  const input = RequestSchema.parse(raw), id = key('panel-request', input.requestId), conversation = conversationId ?? input.requestId
  const target = { executorId: input.executorId, projectId: input.projectId, placement: input.placement }
  if (input.placement === 'auto' && (input.executorId || input.projectId)) throw new ExecutorRequestError(400, 'Automatic placement cannot carry a fixed computer or legacy project')
  const existing = host.store.triggers.get(id)
  if (existing) {
    if (existing.threads[0]?.id !== conversation || existing.text !== input.text || JSON.stringify({...host.store.get(requestTargets(id)), placement: host.store.get(requestTargets(id))?.placement ?? 'fixed'}) !== JSON.stringify(target)) {
      throw new ExecutorRequestError(409, 'Request ID was already used with different contents')
    }
    return { triggerId: id, thread: `${REQUEST_SOURCE}:${conversation}`, result: 'duplicate' as const }
  }
  if (host.store.settings().sources[REQUEST_SOURCE]?.enabled === false) throw new ExecutorRequestError(400, 'User requests are disabled in Source settings')
  if (input.executorId && !conversationId) {
    const device = host.remote?.list().find(device => device.id === input.executorId && device.paired)
    if (!device) throw new ExecutorRequestError(400, 'Select a paired execution computer')
    if (input.projectId && !device.projects.some(project => project.id === input.projectId)) throw new ExecutorRequestError(400, 'Local project is unavailable; refresh the execution computer')
  } else if (!input.executorId && input.projectId) throw new ExecutorRequestError(400, 'A local project requires its execution computer')
  return host.store.atomic(() => {
    host.store.set(requestTargets(id), target)
    const result = host.receive({ id, source: REQUEST_SOURCE, threads: [{ source: REQUEST_SOURCE, id: conversation }],
      actor: { source: REQUEST_SOURCE, id: REQUEST_OWNER }, human: true, addressed: 'direct', at: new Date().toISOString(),
      channel: {source: REQUEST_SOURCE, thread: `${REQUEST_SOURCE}:${conversation}`, address: {conversation}},
      text: input.text, meta: { title: input.text.split('\n')[0]!.slice(0,160) } })
    return { triggerId: id, thread: `${REQUEST_SOURCE}:${conversation}`, result }
  })
}

/** Follow-ups retain their original placement and enter the same authorized Source thread. */
export function appendRequest(host: Parameters<typeof submitRequest>[0], conversation: string, raw: unknown) {
  const id = z.string().uuid().parse(conversation)
  const input = z.object({requestId: z.string().uuid(), text: z.string().trim().min(1).max(32000)}).strict().parse(raw)
  const original = host.store.triggers.get(key('panel-request', id))
  const target = original && host.store.get(requestTargets(original.id))
  if (!target || original?.source !== REQUEST_SOURCE) throw new ExecutorRequestError(404, 'User request not found')
  return submitRequest(host, {...input, ...target}, id)
}
