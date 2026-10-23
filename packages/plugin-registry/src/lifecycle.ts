import type {PluginPlan, PluginPlanEntry} from './types.ts';

export interface PluginDriver {
  apply(entry: PluginPlanEntry): Promise<void>;
  remove(entry: PluginPlanEntry): Promise<void>;
}
/** Shared host/client coordination; native Cordis drivers own actual fibers and services. */
export class PluginCoordinator {
  private readonly applied = new Map<string, PluginPlanEntry>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly driver: PluginDriver) {}
  reconcile(plan: PluginPlan): Promise<void> {
    const entries = structuredClone(plan.entries);
    const run = async () => {
      if (this.closed) return;
      const ids = new Set<string>();
      for (const entry of entries) {if (ids.has(entry.id)) throw new Error('Duplicate plugin entry: '+entry.id); ids.add(entry.id);}
      for (const entry of [...this.applied.values()].reverse()) if (!ids.has(entry.id)) {await this.driver.remove(entry); this.applied.delete(entry.id);}
      for (const entry of entries) {
        const old = this.applied.get(entry.id);
        if (JSON.stringify(old) === JSON.stringify(entry)) continue;
        if (old && old.name !== entry.name) {await this.driver.remove(old); this.applied.delete(entry.id);}
        await this.driver.apply(entry);
        this.applied.set(entry.id, entry);
      }
    };
    const next = this.tail.then(run, run); this.tail = next.catch(() => {}); return next;
  }
  dispose(): Promise<void> {
    this.closed = true;
    const run = async () => {for (const entry of [...this.applied.values()].reverse()) {await this.driver.remove(entry); this.applied.delete(entry.id);}};
    const next = this.tail.then(run, run); this.tail = next.catch(() => {}); return next;
  }
}
