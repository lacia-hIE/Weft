import {WorkerJavaScriptBackend} from '@cloudflare/computer/backends/worker-javascript';
import {Workspace, WorkspaceFilesystemStub, type WorkspaceRuntimeValue, type WorkspaceObserver, type WorkspaceRuntimePendingCall, type WorkspaceModuleBackendHandle, type WorkspaceModuleBackend} from '@cloudflare/computer';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {workspacePath} from './protocol.ts';

export const javascriptRequest = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('start'), source: z.string().min(1).max(262144), input: z.json().optional(), cwd: z.string(), root: z.string().default('/workspace'), writable: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(600000).default(120000)}).strict(),
  z.object({operation: z.enum(['status', 'cancel']), id: z.uuid()}).strict(),
  z.object({operation: z.enum(['list', 'cancelAll'])}).strict(),
  z.object({operation: z.literal('answer'), id: z.uuid(), callId: z.string().min(1).max(256), approved: z.boolean()}).strict(),
]);
export type JavaScriptRequest = z.input<typeof javascriptRequest>;
type Job = {id: string; owner: string; backend: string; cwd: string; root: string; writable: number; created_at: number; state: string; expires_at: number; snapshot: string | null};
export type JavaScriptStatus = {
  id: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired';
  stdout: string; stderr: string; value?: WorkspaceRuntimeValue; exitCode?: number;
  pending: {callId: string; reason: string; since: number}[];
  createdAt?: number; expiresAt?: number; outputTruncated?: boolean;
  error?: {code: string; message: string; retryable: boolean};
}

export type JavaScriptSummary = Omit<JavaScriptStatus, 'stdout' | 'stderr' | 'value'>;
export type JavaScriptList = {tasks: JavaScriptSummary[]};
const summary = ({stdout: _stdout, stderr: _stderr, value: _value, ...state}: JavaScriptStatus): JavaScriptSummary => state;
const TASK_TTL = 86400000, APPROVAL_TTL = 3600000, HISTORY_TTL = 7 * TASK_TTL;
const active = (state: string) => state === 'running' || state === 'waiting';
const missing = (error: unknown) => /not found|no such execution|unknown execution|does not exist/i.test(error instanceof Error ? error.message : String(error));

/** Native replay journals stay in the WorkspaceDO; Agent lifetimes never own these tasks. */
export class WorkspaceJavaScript {
  private readonly computers = new Map<string, Workspace>();
  private readonly connections = new Map<string, WorkspaceModuleBackendHandle>();
  async stopAll():Promise<void> {
    for(const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE state IN ('running','waiting')").toArray())await this.cancel(job);
    for(const computer of this.computers.values())await computer.close();
    this.computers.clear();this.connections.clear();
  }
  constructor(private readonly storage: DurableObjectStorage, private readonly loader: WorkerLoader | undefined, private readonly observer: WorkspaceObserver, private readonly wake: () => Promise<void>) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_javascript_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, backend TEXT NOT NULL, cwd TEXT NOT NULL, root TEXT NOT NULL, writable INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL)');
    const columns = new Set(storage.sql.exec<{name: string}>('PRAGMA table_info(weft_javascript_jobs)').toArray().map(row => row.name));
    if (!columns.has('expires_at')) {storage.sql.exec('ALTER TABLE weft_javascript_jobs ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0'); storage.sql.exec('UPDATE weft_javascript_jobs SET expires_at=created_at+?', TASK_TTL);}
    if (!columns.has('snapshot')) storage.sql.exec('ALTER TABLE weft_javascript_jobs ADD COLUMN snapshot TEXT');
    if (!columns.has('summary')) {
      storage.sql.exec('ALTER TABLE weft_javascript_jobs ADD COLUMN summary TEXT');
      storage.sql.exec("UPDATE weft_javascript_jobs SET summary=json_remove(snapshot, '$.stdout', '$.stderr', '$.value') WHERE snapshot IS NOT NULL");
    }
    storage.sql.exec('CREATE INDEX IF NOT EXISTS weft_javascript_owner ON weft_javascript_jobs(owner, created_at)');
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
        // Module backends receive the raw filesystem, which bypasses observers.
        // Route every filesystem call through Computer's observed RPC facade so
        // private paths, symlinks and file-change notifications share shell policy.
        const observed = new WorkspaceFilesystemStub(computer);
        const fs = new Proxy(host.fs, {get(_target, key) {
          const method = Reflect.get(observed, key, observed);
          if (typeof method !== 'function') throw new Error('JavaScript filesystem operation is unavailable');
          return method.bind(observed);
        }});
        const handle = await backend.connect({...host, fs});
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
  async call(owner: string, raw: unknown): Promise<JavaScriptStatus | JavaScriptList> {
    const request = javascriptRequest.parse(raw);
    await this.cleanup();
    if (request.operation === 'list' || request.operation === 'cancelAll') {
      const tasks: JavaScriptSummary[] = [];
      // Waiting and ended jobs need only their persisted summary. In particular,
      // listing a hundred retained jobs never reads a hundred execution outputs.
      for (const job of this.storage.sql.exec<Job>("SELECT id,owner,backend,cwd,root,writable,created_at,state,expires_at,summary AS snapshot FROM weft_javascript_jobs WHERE owner=? ORDER BY CASE WHEN state IN ('running','waiting') THEN 0 ELSE 1 END, created_at DESC LIMIT 256", owner).toArray()) {
        if (request.operation === 'cancelAll' && active(job.state)) await this.cancel(job);
        if (request.operation === 'cancelAll') {
          const current = this.owned(owner, job.id);
          tasks.push(summary(await this.status(current)));
        } else if (job.state === 'running' || !job.snapshot) tasks.push(summary(await this.status(this.owned(owner, job.id))));
        else tasks.push(JSON.parse(job.snapshot) as JavaScriptSummary);
      }
      return {tasks};
    }
    if (!this.loader) throw new Error('This deployment has no JavaScript Worker Loader');
    if (request.operation === 'start') {
      const cwd = workspacePath(request.cwd);
      if (this.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM weft_javascript_jobs WHERE state='running'").one().n >= 4) throw new Error('Four JavaScript tasks are already running; query their status before starting another');
      // Bound history without removing the identity of a running or waiting task.
      for (const old of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE state IN ('completed','failed','cancelled','expired') ORDER BY created_at DESC LIMIT -1 OFFSET 100").toArray()) {
        await this.dispose(old);
        this.storage.sql.exec('DELETE FROM weft_javascript_jobs WHERE id=?', old.id);
      }
      if (this.storage.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM weft_javascript_jobs').one().n >= 256) throw new Error('JavaScript task capacity reached; finish or cancel old tasks first');
      const root = request.writable ? workspacePath(request.root) : '/workspace';
      const id = crypto.randomUUID(), backend = 'weft-javascript-'+(request.writable ? 'write-' : 'read-')+createHash('sha256').update(root).digest('hex').slice(0, 12);
      const now = Date.now();
      this.storage.sql.exec('INSERT INTO weft_javascript_jobs (id,owner,backend,cwd,root,writable,created_at,state,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', id, owner, backend, cwd, root, Number(request.writable), now, 'running', now + TASK_TTL);
      const runtime = this.runtime({backend, root, writable: Number(request.writable)});
      try {
        await this.wake();
        const handle = await runtime.exec(request.source, {id, backend, cwd, encoding: 'utf8', timeoutMs: request.timeoutMs, ...(request.input === undefined ? {} : {input: request.input}), onInterrupt: 'replay', output: false});
        handle[Symbol.dispose]();
      } catch (error) {this.storage.sql.exec('DELETE FROM weft_javascript_jobs WHERE id=?', id); throw error;}
      await this.storage.sync();
      return this.status(this.owned(owner, id));
    }
    if (!('id' in request)) throw new Error('Task id is required');
    const job = this.owned(owner, request.id);
    const runtime = this.runtime(job);
    if (request.operation === 'cancel') {await this.cancel(job); return this.status(this.owned(owner, job.id));}
    if (request.operation === 'answer') {
      if (!(await this.pending(runtime, job)).some(call => call.callId === request.callId)) throw new Error('JavaScript approval is no longer waiting');
      job.expires_at = job.created_at + TASK_TTL;
      this.storage.sql.exec("UPDATE weft_javascript_jobs SET state='running',expires_at=? WHERE id=?", job.expires_at, job.id);
      await this.wake();
      await runtime.respond(job.id, request.callId, {approved: request.approved}, {backend: job.backend});
    }
    await this.storage.sync();
    return this.status(job);
  }
  async revokeWrites(owner: string): Promise<void> {
    for (const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE owner=? AND writable=1 AND state IN ('running','waiting')", owner).toArray()) {
      await this.cancel(job);
    }
  }
  private save(job: Job, snapshot: JavaScriptStatus): JavaScriptStatus {
    snapshot.createdAt = job.created_at;
    snapshot.expiresAt = job.expires_at;
    // Bound the retained receipt; large data belongs in a workspace output file.
    if (snapshot.stdout.length + snapshot.stderr.length > 65536) {
      snapshot.stdout = snapshot.stdout.slice(-49152); snapshot.stderr = snapshot.stderr.slice(-16384); snapshot.outputTruncated = true;
    }
    if (snapshot.value !== undefined && JSON.stringify(snapshot.value).length > 65536) {delete snapshot.value; snapshot.outputTruncated = true;}
    this.storage.sql.exec('UPDATE weft_javascript_jobs SET state=?,expires_at=?,snapshot=?,summary=? WHERE id=?', snapshot.status, job.expires_at, JSON.stringify(snapshot), JSON.stringify(summary(snapshot)), job.id);
    return snapshot;
  }
  private receipt(job: Job): JavaScriptStatus {
    return job.snapshot ? JSON.parse(job.snapshot) as JavaScriptStatus : {id: job.id, status: job.state as JavaScriptStatus['status'], stdout: '', stderr: '', pending: [], createdAt: job.created_at, expiresAt: job.expires_at};
  }
  private async cancel(job: Job): Promise<void> {
    if (!active(job.state)) return;
    job.expires_at = job.created_at + TASK_TTL;
    this.storage.sql.exec("UPDATE weft_javascript_jobs SET state='running',expires_at=? WHERE id=?", job.expires_at, job.id);
    await this.wake();
    try {await this.runtime(job).killExec(job.id, {backend: job.backend});}
    catch (error) {
      if (!missing(error)) throw error;
      this.save(job, {id: job.id, status: 'expired', stdout: '', stderr: '', pending: [], error: {code: 'TASK_LOG_EXPIRED', message: 'The execution log is no longer available.', retryable: false}});
      return;
    }
    // A task may have completed before cancellation reached the backend.
    // Preserve that outcome rather than inventing a cancelled result.
    await this.readStatus(job);
  }
  private async dispose(job: Job): Promise<void> {
    try {await this.runtime(job).disposeExec(job.id, {backend: job.backend});} catch (error) {if (!missing(error)) throw error;}
  }
  nextAlarm(): number | undefined {
    const row = this.storage.sql.exec<{next: number | null}>("SELECT MIN(CASE WHEN state='running' THEN ? WHEN state='expired' THEN created_at+? ELSE expires_at END) AS next FROM weft_javascript_jobs", Date.now() + 30000, HISTORY_TTL).one();
    return row.next === null ? undefined : Math.max(Date.now() + 30000, row.next);
  }
  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE expires_at<=? AND state!='expired'", now).toArray()) {
      if (active(job.state)) {
        try {await this.runtime(job).killExec(job.id, {backend: job.backend});} catch (error) {if (!missing(error)) continue;}
      }
      try {await this.dispose(job);} catch {continue;}
      this.save(job, {id: job.id, status: 'expired', stdout: '', stderr: '', pending: [], error: {code: job.state === 'waiting' ? 'TASK_APPROVAL_EXPIRED' : 'TASK_EXPIRED', message: job.state === 'waiting' ? 'Approval was not answered within one hour; the task has expired.' : 'The task and its retained output have expired.', retryable: false}});
    }
    this.storage.sql.exec("DELETE FROM weft_javascript_jobs WHERE state='expired' AND created_at<=?", now - HISTORY_TTL);
  }
  async recover(): Promise<void> {
    await this.cleanup();
    for (const job of this.storage.sql.exec<Job>("SELECT * FROM weft_javascript_jobs WHERE state='running'").toArray()) await this.status(job);
  }
  private async status(job: Job): Promise<JavaScriptStatus> {
    if (!active(job.state) && job.snapshot) return this.receipt(job);
    try {return await this.readStatus(job);}
    catch (error) {
      if (missing(error)) return this.save(job, {id: job.id, status: 'expired', stdout: '', stderr: '', pending: [], error: {code: 'TASK_LOG_EXPIRED', message: 'The execution log is no longer available. Start a new task if needed.', retryable: false}});
      const snapshot = this.receipt(job);
      snapshot.error = {code: 'TASK_STATUS_UNAVAILABLE', message: 'The task could not be reconnected. Refresh to retry.', retryable: true};
      return snapshot;
    }
  }
  private async readStatus(job: Job): Promise<JavaScriptStatus> {
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
      if (snapshot.pending.length) {snapshot.status = 'waiting'; job.expires_at = Math.min(job.created_at + TASK_TTL, snapshot.pending[0]!.since + APPROVAL_TTL);}
    }
    const current = this.storage.sql.exec<Job>('SELECT * FROM weft_javascript_jobs WHERE id=?', job.id).toArray()[0];
    if (current && !active(current.state) && current.snapshot) return this.receipt(current);
    return this.save(job, snapshot);
  }
}
