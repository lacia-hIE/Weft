import {WorkerEntrypoint} from 'cloudflare:workers';
import type {WorkerObservationProps} from './loader.ts';

export interface DynamicWorkerUsage extends WorkerObservationProps {
  source: 'weft.dynamic-worker';
  event: 'invocation';
  eventTimestamp: number | null;
  cpuTimeMs: number | null;
  wallTimeMs: number | null;
  outcome: string;
  entrypoint?: string;
  executionModel?: string;
  exceptionCount: number;
  logCount: number;
}
const measured = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Metrics only: guest logs, exception messages, URLs and RPC arguments stay out of usage records. */
export class DynamicWorkerTail extends WorkerEntrypoint<unknown, WorkerObservationProps> {
  protected record(value: DynamicWorkerUsage): void {console.log(value);}
  override tail(events: TraceItem[]): void {
    for (const event of events) this.record({
      ...this.ctx.props, source: 'weft.dynamic-worker', event: 'invocation',
      eventTimestamp: measured(event.eventTimestamp), cpuTimeMs: measured(event.cpuTime), wallTimeMs: measured(event.wallTime),
      outcome: event.outcome, ...(event.entrypoint ? {entrypoint: event.entrypoint} : {}),
      ...(event.executionModel ? {executionModel: event.executionModel} : {}),
      exceptionCount: event.exceptions?.length ?? 0, logCount: event.logs?.length ?? 0,
    });
  }
}
