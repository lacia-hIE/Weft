import { DshExecutor, type ExecutorHost } from './dsh.ts'
import { requestTargets } from '../app/requests.ts'
import { RemoteExecutor } from './remote.ts'
import type { AssessmentOutcome, Assignment, Ticket } from '../core/index.ts'

/** Placement is captured once per Ticket. Changing the default never moves existing work. */
export class HybridExecutor extends DshExecutor {
  constructor(private readonly placement: ExecutorHost, readonly remote: RemoteExecutor) { super(placement) }
  override prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const prepared = super.prepare(ticket, outcome), target = this.placement.store.get(requestTargets(ticket.origin.triggerId))
    const id = target ? target.executorId : this.placement.store.settings().executor.executorId
    return { ...prepared, execution: { ...prepared.execution!, ...(id ? {executorId: id} : {}), ...(target?.projectId ? {projectId: target.projectId} : {}) } }
  }
  override start(ticket: Ticket, assignment: Assignment): void {
    if (ticket.execution?.executorId) this.remote.start(ticket, assignment)
    else super.start(ticket, assignment)
  }
  override deliver(ticket: Ticket, assignment: Assignment): void {
    if (ticket.execution?.executorId) this.remote.deliver(ticket, assignment)
    else super.deliver(ticket, assignment)
  }
  override stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    if (ticket.execution?.executorId) this.remote.stop(ticket, assignment, reason)
    else super.stop(ticket, assignment, reason)
  }
  override activeCount(): number { return super.activeCount() + this.remote.activeCount() }
}
