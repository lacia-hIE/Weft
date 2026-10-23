import {WorkerJavaScriptBackend} from '@cloudflare/computer/backends/worker-javascript';
import {Workspace, type WorkspaceRuntimeValue, type WorkspaceObserver, type WorkspaceRuntimePendingCall, type WorkspaceModuleBackendHandle, type WorkspaceModuleBackend} from '@cloudflare/computer';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {workspacePath} from './protocol.ts';

export const javascriptRequest = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('start'), source: z.string().min(1).max(262144), input: z.json().optional(), cwd: z.string(), root: z.string().default('/workspace'), writable: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(600000).default(120000)}).strict(),
  z.object({operation: z.enum(['status', 'cancel']), id: z.uuid()}).strict(),
  z.object({operation: z.literal('answer'), id: z.uuid(), callId: z.string().min(1).max(256), approved: z.boolean()}).strict(),
]);
export type JavaScriptRequest = z.input<typeof javascriptRequest>;
type Job = {id: string; owner: string; backend: string; cwd: string; root: string; writable: number; created_at: number; state: string};
export type JavaScriptStatus = {
  id: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  stdout: string; stderr: string; value?: WorkspaceRuntimeValue; exitCode?: number;
  pending: {callId: string; reason: string; since: number}[];
}

/** Native replay journals stay in the WorkspaceDO; Agent lifetimes never own these tasks. */
export class WorkspaceJavaScript {
  private readonly computers = new Map<string, Workspace>();
  private readonly connections = new Map<string, WorkspaceModuleBackendHandle>();
  constructor(private readonly storage: DurableObjectStorage, private readonly loader: WorkerLoader | undefined, private readonly observer: WorkspaceObserver) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_javascript_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, backend TEXT NOT NULL, cwd TEXT NOT NULL, root TEXT NOT NULL, writable INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL)');
  }
  private runtime(job: Pick<Job, 'backend' | 'root' | 'writable'>): Workspace['runtime'] {
    const cached = this.computers.get(job.backend);
    if (cached) return cached.runtime;
    if (!this.loader) throw new Error('This deployment has no JavaScript Worker Loader');
    const backend = new WorkerJavaScriptBackend({
      loader: this.loader, id: job.backend, root: job.root, access: job.writable ? 'read-write' : 'read',
      onInterrupt: 'replay', maxCpuMs: 30000, defaultTimeoutMs: 120000, maxTimeoutMs: 600000,
      maxResultBytes: 4194304, maxStdioBytes: 1048576, maxSourceBytes: 262144,
      maxRetainedExecutions: 256, retentionMs: 86400000, globalOutbound: null,
      modules: {'ws:approval': {request: async ([reason], context) => {
        const text = z.string().trim().min(1).max(4000).parse(reason);
        return context.interrupt({reason: text});
      }}},
    });
    const connected: WorkspaceModuleBackend = {
      id: backend.id, type: backend.type, protocol: 'module', callable: true, description: backend.description,
      connect: async host => {
        const handle = await backend.connect(host);
        this.connections.set(job.backend, handle);
        return handle;
      },
    };
    const computer = new Workspace({storage: this.storage, backends: [connected], observer: this.observer, output: false});
    this.computers.set(job.backend, computer);
    return computer.runtime;
  }
  private owned(owner: string, id: string): Job {
    const job = this.storage.sql.exec<Job>('SELECT * FROM weft_javascript_jobs WHERE id=? AND owner=?', id, owner).toArray()[0];
    if (!job) throw new Error('JavaScript task not found in this Session');
    return job;
  }
  private async pending(runtime: Workspace['runtime'], job: Job): Promise<WorkspaceRuntimePendingCall[]> {
    return (await runtime.pending()).filter(call => call.id === job.id && call.backend === job.backend);
  }
  async call(owner: string, raw: unknown): Promise<JavaScriptStatus> {
    const request = javascriptRequest.parse(raw);
    if (!this.loader) throw new Error('This deployment has no JavaScript Worker Loader');
    if (request.operation === 'start') {
      const cwd = workspacePath(request.cwd);
      if (this.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM weft_javascript_jobs WHERE state='running'").one().n >= 4) throw new Error('Four JavaScript tasks are already running; query their status before starting another');
      // Bound history without removing the identity of a running or waiting task.
      this.storage.sql.exec("DELETE FROM weft_javascript_jobs WHERE id IN (SELECT id FROM weft_javascript_jobs WHERE state IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT -1 OFFSET 100)");
      if (this.storage.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM weft_javascript_jobs').one().n >= 256) throw new Error('JavaScript task capacity reached; finish or cancel old tasks first');
      const root = request.writable ? workspacePath(request.root) : '/workspace';
      const id = crypto.randomUUID(), backend = 'weft-javascript-'+(request.writable ? 'write-' : 'read-')+createHash('sha256').update(root).digest('hex').slice(0, 12);
      this.storage.sql.exec('INSERT INTO weft_javascript_jobs VALUES (?,?,?,?,?,?,?,?)', id, owner, backend, cwd, root, Number(request.writable), Date.now(), 'running');
      const runtime = this.runtime({backend, root, writable: Number(request.writable)});
      try {
        const handle = await runtime.exec(request.source, {id, backend, cwd, encoding: 'utf8', timeoutMs: request.timeoutMs, ...(request.input === undefined ? {} : {input: request.input}), onInterrupt: 'replay', output: false});
        handle[Symbol.dispose]();
      } catch (error) {this.storage.sql.exec('DELETE FROM weft_javascript_jobs WHERE id=?', id); throw error;}
      await this.storage.sync();
      return this.status(this.owned(owner, id));
    }
    const job = this.owned(owner, request.id);
    const runtime = this.runtime(job);
    if (request.operation === 'cancel') await runtime.killExec(job.id, {backend: job.backend});
    if (request.operation === 'answer') {
      if (!(await this.pending(runtime, job)).some(call => call.callId === request.callId)) throw new Error('JavaScript approval is no longer waiting');
      await runtime.respond(job.id, request.callId, {approved: request.approved}, {backend: job.backend});
    }
    await this.storage.sync();
    return this.status(job);
  }
  async revokeWrites(owner: string): Promise<void> {
    for (const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE owner=? AND writable=1 AND state IN ('running','waiting')", owner).toArray()) {
      await this.runtime(job).killExec(job.id, {backend: job.backend});
      this.storage.sql.exec("UPDATE weft_javascript_jobs SET state='cancelled' WHERE id=?", job.id);
    }
  }
  hasRunning(): boolean {return this.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM weft_javascript_jobs WHERE state='running'").one().n > 0;}
  async recover(): Promise<void> {
    for (const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE state='running'").toArray()) {
      try {await this.status(job);}
      catch {this.storage.sql.exec("UPDATE weft_javascript_jobs SET state='failed' WHERE id=?", job.id);}
    }
  }
  private async status(job: Job): Promise<JavaScriptStatus> {
    const runtime = this.runtime(job);
    await runtime.recover();
    // Use the native backend's bounded event subscription. Cancelling a pending
    // read of Computer 0.7's public UTF-8 wrapper races its mutable reader slot.
    const connection = this.connections.get(job.backend)!;
    const envelope = await connection.getExec({id: job.id});
    const reader = envelope.events.getReader();
    const decoders = {stdout: new TextDecoder(), stderr: new TextDecoder()};
    const snapshot: JavaScriptStatus = {id: job.id, status: 'running', stdout: '', stderr: '', pending: []};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), 100);});
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next === null || next.done) break;
        const event = next.value;
        if (event.name === 'stdout' || event.name === 'stderr') snapshot[event.name] += decoders[event.name].decode(event.value, {stream: true});
        if (event.name === 'exit') {
          snapshot.exitCode = event.code;
          snapshot.status = event.code === 0 ? 'completed' : event.code === 130 ? 'cancelled' : 'failed';
          if (event.result !== undefined) snapshot.value = event.result;
          break;
        }
      }
    } finally {
      clearTimeout(timer); await reader.cancel(); reader.releaseLock();
      snapshot.stdout += decoders.stdout.decode(); snapshot.stderr += decoders.stderr.decode();
    }
    if (snapshot.status === 'running') {
      snapshot.pending = (await this.pending(runtime, job)).map(call => ({callId: call.callId, reason: z.object({reason: z.string()}).parse(call.payload).reason, since: call.since}));
      if (snapshot.pending.length) snapshot.status = 'waiting';
    }
    this.storage.sql.exec('UPDATE weft_javascript_jobs SET state=? WHERE id=?', snapshot.status, job.id);
    return snapshot;
  }
}
