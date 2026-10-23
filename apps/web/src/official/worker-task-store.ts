import type {JavaScriptStatus, JavaScriptSummary, JavaScriptList} from '../../../../packages/workspace/src/javascript.ts';

export const unfinished = (task: JavaScriptSummary) => task.status === 'running' || task.status === 'waiting';
export type TaskRequest = (sessionId: string, operation: 'list' | 'status' | 'cancel' | 'cancelAll', id?: string, signal?: AbortSignal) => Promise<JavaScriptList | JavaScriptStatus>;
export interface TaskSnapshot {value?: JavaScriptList; details: ReadonlyMap<string, JavaScriptStatus>; error: boolean; busy: boolean}

/** One in-flight read and one timer per Session, shared by all cards and dialogs. */
export class WorkerTaskStore {
  private readonly subscribers = new Map<() => void, {id?: string; details: boolean}>();
  private snapshot: TaskSnapshot = {details: new Map(), error: false, busy: false};
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private mutationError = false;
  private generation = 0;
  constructor(private readonly sessionId: string, private readonly request: TaskRequest, private readonly hidden: () => boolean, private readonly idle: () => void) {}
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<TaskSnapshot>) {
    this.snapshot = {...this.snapshot, ...patch};
    for (const listener of this.subscribers.keys()) listener();
  }
  subscribe(listener: () => void, id?: string, details = false): () => void {
    this.subscribers.set(listener, {...(id ? {id} : {}), details});
    // Coalesce React's many subscriptions in the same commit.
    if (!this.abort && !this.timer) this.timer = setTimeout(() => {this.timer = undefined; void this.read();}, 0);
    else if (details && id && !this.snapshot.details.has(id)) this.refresh(false);
    return () => {
      this.subscribers.delete(listener);
      if (!this.subscribers.size) {this.stop(); this.snapshot = {...this.snapshot, details: new Map()}; this.idle();}
    };
  }
  stop() {this.generation++; this.abort?.abort(); this.abort = undefined; clearTimeout(this.timer); this.timer = undefined;}
  refresh(clearError = true) {
    if (clearError) this.mutationError = false;
    this.stop();
    if (this.subscribers.size && !this.hidden() && !this.snapshot.busy) this.timer = setTimeout(() => {this.timer = undefined; void this.read();}, 0);
  }
  private async read() {
    if (this.abort || this.hidden() || !this.subscribers.size || this.snapshot.busy) return;
    const generation = this.generation, abort = this.abort = new AbortController();
    let retry = false;
    try {
      const value = await this.request(this.sessionId, 'list', undefined, abort.signal) as JavaScriptList;
      if (abort.signal.aborted) return;
      const details = new Map(this.snapshot.details);
      const wanted = new Set([...this.subscribers.values()].filter(row => row.details && row.id).map(row => row.id!));
      for (const [id] of details) if (!wanted.has(id)) details.delete(id);
      for (const id of wanted) {
        const prior = details.get(id), current = value.tasks.find(task => task.id === id);
        if (prior && current && !unfinished(prior) && prior.status === current.status) continue;
        details.set(id, await this.request(this.sessionId, 'status', id, abort.signal) as JavaScriptStatus);
      }
      if (!abort.signal.aborted) this.publish({value, details, error: this.mutationError});
    } catch {if (!abort.signal.aborted) {this.publish({error: true}); retry = true;}}
    finally {
      if (generation === this.generation) {
        this.abort = undefined;
        const tasks = this.snapshot.value?.tasks ?? [];
        if (this.subscribers.size && !this.hidden() && (retry || tasks.some(unfinished))) this.timer = setTimeout(() => {this.timer = undefined; void this.read();}, retry ? 15000 : tasks.some(task => task.status === 'running') ? 3000 : 15000);
      }
    }
  }
  cancel = async (id?: string) => {
    if (this.snapshot.busy) return;
    this.stop(); this.mutationError = false; this.publish({busy: true, error: false});
    try {await this.request(this.sessionId, id ? 'cancel' : 'cancelAll', id); this.snapshot = {...this.snapshot, details: new Map()};}
    catch {this.mutationError = true;}
    finally {this.publish({busy: false, error: this.mutationError}); this.refresh(false);}
  };
}
