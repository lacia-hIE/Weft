import {WorkerJavaScriptBackend} from '@cloudflare/computer/backends/worker-javascript';
import type {WorkspaceRuntime, WorkspaceRuntimeValue, WorkspaceRegisteredBackend, WorkspaceRuntimePendingCall} from '@cloudflare/computer';
import {z} from 'zod';
import {workspacePath} from './protocol.ts';

export const javascriptRequest = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('start'), source: z.string().min(1).max(262144), input: z.json().optional(), cwd: z.string(), writable: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(600000).default(120000)}).strict(),
  z.object({operation: z.enum(['status', 'cancel']), id: z.uuid()}).strict(),
  z.object({operation: z.literal('answer'), id: z.uuid(), callId: z.string().min(1).max(256), approved: z.boolean()}).strict(),
]);
export type JavaScriptRequest = z.infer<typeof javascriptRequest>;
interface Job {id: string; owner: string; backend: string; cwd: string; created_at: number}
export interface JavaScriptStatus {
  id: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  stdout: string; stderr: string; value?: WorkspaceRuntimeValue; exitCode?: number;
  pending: {callId: string; reason: string; since: number}[];
}

/** Native replay journals stay in the WorkspaceDO; Agent lifetimes never own these tasks. */
export class WorkspaceJavaScript {
  readonly backends: WorkspaceRegisteredBackend[];
  constructor(private readonly storage: DurableObjectStorage, loader: WorkerLoader | undefined) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_javascript_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, backend TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL)');
    this.backends = loader ? [false, true].map(writable => new WorkerJavaScriptBackend({
      loader, id: writable ? 'weft-javascript-write' : 'weft-javascript-read', root: '/workspace', access: writable ? 'read-write' : 'read',
      onInterrupt: 'replay', maxCpuMs: 30000, defaultTimeoutMs: 120000, maxTimeoutMs: 600000,
      maxResultBytes: 4194304, maxStdioBytes: 1048576, maxSourceBytes: 262144,
      maxRetainedExecutions: 256, retentionMs: 86400000, globalOutbound: null,
      modules: {'ws:approval': {request: async ([reason], context) => {
        const text = z.string().trim().min(1).max(4000).parse(reason);
        return context.interrupt({reason: text});
      }}},
    })) : [];
  }
  private owned(owner: string, id: string): Job {
    const job = this.storage.sql.exec<Job>('SELECT * FROM weft_javascript_jobs WHERE id=? AND owner=?', id, owner).toArray()[0];
    if (!job) throw new Error('JavaScript task not found in this Session');
    return job;
  }
  private async pending(runtime: WorkspaceRuntime, job: Job): Promise<WorkspaceRuntimePendingCall[]> {
    return (await runtime.pending()).filter(call => call.id === job.id && call.backend === job.backend);
  }
  async call(runtime: WorkspaceRuntime, owner: string, raw: JavaScriptRequest): Promise<JavaScriptStatus> {
    const request = javascriptRequest.parse(raw);
    if (!this.backends.length) throw new Error('This deployment has no JavaScript Worker Loader');
    if (request.operation === 'start') {
      const cwd = workspacePath(request.cwd);
      // Completed executions expire with the native journal. Never discard a waiting task's owner.
      if (this.storage.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM weft_javascript_jobs').one().n >= 256) throw new Error('JavaScript task capacity reached; finish or cancel old tasks first');
      const id = crypto.randomUUID(), backend = request.writable ? 'weft-javascript-write' : 'weft-javascript-read';
      this.storage.sql.exec('INSERT INTO weft_javascript_jobs VALUES (?,?,?,?,?)', id, owner, backend, cwd, Date.now());
      try {
        const handle = await runtime.exec(request.source, {id, backend, cwd, encoding: 'utf8', timeoutMs: request.timeoutMs, ...(request.input === undefined ? {} : {input: request.input}), onInterrupt: 'replay', output: false});
        handle[Symbol.dispose]();
      } catch (error) {this.storage.sql.exec('DELETE FROM weft_javascript_jobs WHERE id=?', id); throw error;}
      await this.storage.sync();
      return this.status(runtime, this.owned(owner, id));
    }
    const job = this.owned(owner, request.id);
    if (request.operation === 'cancel') await runtime.killExec(job.id, {backend: job.backend});
    if (request.operation === 'answer') {
      if (!(await this.pending(runtime, job)).some(call => call.callId === request.callId)) throw new Error('JavaScript approval is no longer waiting');
      await runtime.respond(job.id, request.callId, {approved: request.approved}, {backend: job.backend});
    }
    await this.storage.sync();
    return this.status(runtime, job);
  }
  private async status(runtime: WorkspaceRuntime, job: Job): Promise<JavaScriptStatus> {
    const handle = await runtime.getExec(job.id, {backend: job.backend, encoding: 'utf8', resume: 'full', output: false});
    const reader = handle.getReader();
    const snapshot: JavaScriptStatus = {id: job.id, status: 'running', stdout: '', stderr: '', pending: []};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), 100);});
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next === null || next.done) break;
        const event = next.value;
        if (event.name === 'stdout' || event.name === 'stderr') snapshot[event.name] += event.value;
        if (event.name === 'exit') {
          snapshot.exitCode = event.code;
          snapshot.status = event.code === 0 ? 'completed' : event.code === 130 ? 'cancelled' : 'failed';
          if (event.result !== undefined) snapshot.value = event.result;
          break;
        }
      }
    } finally {clearTimeout(timer); await reader.cancel(); handle[Symbol.dispose]();}
    if (snapshot.status === 'running') {
      snapshot.pending = (await this.pending(runtime, job)).map(call => ({callId: call.callId, reason: z.object({reason: z.string()}).parse(call.payload).reason, since: call.since}));
      if (snapshot.pending.length) snapshot.status = 'waiting';
    }
    return snapshot;
  }
}
