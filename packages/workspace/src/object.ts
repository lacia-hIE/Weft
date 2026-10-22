import {createHash} from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { FsError } from '@deepseek-ai/dsh-fs';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import curlCommands from '@cloudflare/computer/shell/curl';
import { LegacyContainerBackend } from '@cloudflare/computer/backends/container-legacy';
import { CONTAINER_EGRESS_ADDRESS, CONTAINER_HOSTS, CONTAINER_TOUCH_MS, remoteContainerHost, type ContainerHostActivity } from './container-host.ts';
import { WorkspaceStore } from './store.ts';
import { shellPolicy, type ShellSandbox } from './shell.ts';
import { CONTAINER_MOUNT_IGNORE } from './container-policy.ts';
import { shellOutputFrames } from './exec-output.ts';
import { PROCESS_PATH } from './process-protocol.ts';
import {ContainerAdmission} from './container-admission.ts';
import type {BackendHandle, WorkspaceRuntimeExecHandle} from '@cloudflare/computer';
import type {SessionDO} from '../../../apps/worker/src/index.ts';
import {sessionAddress} from '../../tenant/src/index.ts';
import { fsStatus, workspaceAddress, workspaceScopeSchema, workspaceOperationSchema, workspacePath, type WorkspaceScope, type WorkspaceOperation } from './protocol.ts';
import {AttachmentError, type FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {attachmentOperationSchema, ATTACHMENT_ROOT, UPLOAD_CHUNK_BYTES} from '../../native-attachments/src/storage.ts';
import type {ImageVariantRecord} from '../../native-attachments/src/image-variants.ts';
import {storedFilePath} from '../../../.generated/official-file-reference.ts';

interface Env { WORKSPACES: DurableObjectNamespace<WorkspaceDO>; SESSIONS: DurableObjectNamespace<SessionDO>; LOADER?: WorkerLoader }

/** The selector of the container backend, beside Computer's default `worker-shell`. */
export const CONTAINER_SHELL = 'container-shell';
/** Container sizes an environment may choose; each is a Container application with that instance type. */
export const CONTAINER_INSTANCES = Object.keys(CONTAINER_HOSTS) as (keyof typeof CONTAINER_HOSTS)[];
export type ContainerInstance = keyof typeof CONTAINER_HOSTS;
const DEFAULT_INSTANCE: ContainerInstance = 'basic';

/** No unscoped Computer stub is exposed to clients or model tools. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly files: WorkspaceStore;
  /**
   * The workspace's Linux container, where the deployment provides one; its
   * WorkspaceContainerDO hosts it. It mounts the same volume at /workspace;
   * Weft's private attachment area stays local to the container disk, so it is
   * neither readable from the container nor synced back.
   */
  private readonly containerHost: () => ContainerHostActivity | undefined;
  private readonly container: LegacyContainerBackend | undefined;
  private readonly watchers = new Map<string, {path: string; invalidate(): void; close(endStream?: boolean): void}>();
  /** The sandbox of every running shell execution, by execution id. */
  private readonly sandboxes = new Map<string, ShellSandbox>();
  private processSyncTail: Promise<unknown> = Promise.resolve();
  private readonly admission: ContainerAdmission;
  private containerConnection: BackendHandle | undefined;
  private readonly containerRuns = new Map<string, {run: Promise<WorkspaceRuntimeExecHandle<'utf8'>>; release(): void}>();
  private stopping: Promise<Response> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.admission = new ContainerAdmission(ctx.storage.sql);
    // Shell commands run in just-bash inside a Dynamic Worker whose filesystem calls come back
    // here through `WorkspaceServiceProxy`; public egress serves its curl command.
    const shell = env.LOADER ? new WorkerShellBackend({
      loader: env.LOADER, ctx, workspace: {binding: 'WORKSPACES', id: ctx.id.toString()},
      commands: [curlCommands], egress: {mode: 'direct'},
    }) : undefined;
    // Only a deployment that declares the container hosts exports them as namespaces; the size this
    // workspace last asked for picks the host each time the container starts.
    const exported = ctx.exports as unknown as Record<string, Partial<DurableObjectNamespace> | undefined> | undefined;
    const host = (instance: ContainerInstance) => {
      const hosts = exported?.[CONTAINER_HOSTS[instance]];
      return typeof hosts?.getByName === 'function' ? hosts as DurableObjectNamespace : undefined;
    };
    this.containerHost = () => host(this.containerInstance())?.getByName(ctx.id.toString()) as unknown as ContainerHostActivity | undefined;
    this.container = CONTAINER_INSTANCES.every(instance => host(instance)) ? new LegacyContainerBackend({
      id: CONTAINER_SHELL, workspace: {binding: 'WORKSPACES', id: ctx.id.toString()},
      container: () => ({getWorkspaceContainer: () => remoteContainerHost(host(this.containerInstance())!.getByName(ctx.id.toString()) as unknown as Parameters<typeof remoteContainerHost>[0], () => this.admission.stopping ? this.admission.epoch : undefined)}),
      // Private attachments stay inaccessible; dependencies and caches stay local and can be rebuilt.
      // Source, .git, and deliverables retain their existing persistence.
      egress: {mode: 'direct'}, containerEnv: {MOUNT_IGNORE: CONTAINER_MOUNT_IGNORE},
      // computerd reaches the workspace through an outbound intercept. A container with Internet access
      // resolves names publicly, where the default host name does not exist, so the intercept is an address.
      egressHost: CONTAINER_EGRESS_ADDRESS,
    }) : undefined;
    const backend = this.container ? {id: this.container.id, type: this.container.type, connect: async () => {
      const connection = await this.container!.connect();
      this.containerConnection = connection;
      return connection;
    }} : undefined;
    const backends = [shell, backend].filter(backend => backend !== undefined);
    this.files = new WorkspaceStore(ctx.storage, shell ? {backends, observer: shellPolicy(changes => {
      this.files.externalChanges(changes);
      for (const change of changes) this.invalidate(change.path);
    }, () => [...this.sandboxes.values()])} : undefined);
  }
  /** The Workspace RPC surface for this object's own shell Dynamic Worker (via `WorkspaceServiceProxy`). */
  __getWorkspaceStub() { return this.files.stub(); }

  /** computerd's session upgrade from this workspace's container. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === PROCESS_PATH) {
      let input: unknown;
      try {input = JSON.parse(request.headers.get('x-weft-workspace') ?? 'null');} catch {return new Response('Invalid scope', {status: 403});}
      const scope = workspaceScopeSchema.safeParse(input);
      const instance = request.headers.get('x-weft-container-instance') as ContainerInstance;
      if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) return new Response('Workspace scope mismatch', {status: 403});
      if (!this.container || !CONTAINER_INSTANCES.includes(instance)) return new Response('This deployment has no workspace container', {status: 501});
      const rawEpoch = request.headers.get('x-weft-container-epoch');
      const epoch = rawEpoch === null ? this.admission.epoch : Number(rawEpoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) return new Response('Invalid container connection identity', {status: 400});
      try {this.admission.assert(epoch);} catch (error) {return new Response((error as Error).message, {status: 409});}
      this.rememberInstance(instance);
      await this.syncProcesses(scope.data, true, epoch);
      try {this.admission.assert(epoch);} catch (error) {return new Response((error as Error).message, {status: 409});}
      const namespaces = this.ctx.exports as unknown as Record<string, DurableObjectNamespace>;
      const response = await namespaces[CONTAINER_HOSTS[instance]]!.getByName(this.ctx.id.toString()).fetch(request);
      try {this.admission.assert(epoch);} catch (error) {response.webSocket?.close(); return new Response((error as Error).message, {status: 409});}
      const headers = new Headers(response.headers);
      headers.set('x-weft-container-epoch', String(epoch));
      return new Response(response.body, {status: response.status, headers, ...(response.webSocket ? {webSocket: response.webSocket} : {})});
    }
    if (this.container) return this.container.handleFetch(request);
    return new Response('Not found', {status: 404});
  }

  /** Pull while processes are running and before acknowledging their final exit. */
  async syncProcesses(input: WorkspaceScope, pull = true, epoch = this.admission.epoch): Promise<void> {
    const scope = workspaceScopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Workspace scope mismatch');
    if (!this.container) throw new Error('This deployment has no workspace container');
    this.admission.assert(epoch);
    const next = this.processSyncTail.then(async () => {
      this.admission.assert(epoch);
      await this.containerHost()?.touch();
      const paths = await this.files.synchronize(CONTAINER_SHELL, pull);
      for (const path of paths) this.invalidate(path);
      this.admission.assert(epoch);
    });
    this.processSyncTail = next.catch(() => {});
    await next;
  }

  async containerState(input: WorkspaceScope) {
    const scope = workspaceScopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Workspace scope mismatch');
    const state = await this.containerHost()?.state();
    return {available: !!this.container && state?.available === true, status: this.admission.stopping ? 'stopping' as const : state?.running ? 'running' as const : 'stopped' as const};
  }

  /** The object owns completion even if the browser closes the settings panel. */
  stopContainer(input: WorkspaceScope, sessions: string[]): Promise<Response> {
    const scope = workspaceScopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Workspace scope mismatch');
    if (this.stopping) return this.stopping.then(response => response.clone());
    const epoch = this.admission.begin();
    const operation = this.finishContainerStop(scope, sessions, epoch);
    this.stopping = operation;
    const clear = () => {if (this.stopping === operation) this.stopping = undefined;};
    this.ctx.waitUntil(operation.then(clear, clear));
    return operation.then(response => response.clone());
  }
  private async finishContainerStop(scope: WorkspaceScope, sessions: string[], epoch: number): Promise<Response> {
    const host = this.containerHost();
    let held = false;
    try {
      if (!this.container || !host || !(await host.state()).available) return Response.json({error: 'This deployment has no workspace container', code: 'CONTAINER_UNAVAILABLE'}, {status: 501, headers: {'cache-control': 'private, no-store'}});
      await host.beginStop(epoch); held = true;
      const running = (await host.state()).running;
      // Archive/session-stop also disables schedules; only cancel container activity here.
      for (let offset = 0; offset < sessions.length; offset += 8) {
        const results = await Promise.allSettled(sessions.slice(offset, offset + 8).map(sessionId => {
          const address = {tenantId: scope.tenantId, environmentId: scope.environmentId ?? 'default', sessionId};
          return this.env.SESSIONS.getByName(sessionAddress(address)).nativeStopContainerProcesses(address, scope.workspaceId);
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      const executions = [...this.containerRuns];
      await Promise.allSettled(executions.map(([, execution]) => execution.run));
      await Promise.all(executions.map(async ([id, execution]) => {await this.killExec(scope, id); execution.release();}));
      await this.processSyncTail;
      if (running) {
        const paths = await this.files.synchronize(CONTAINER_SHELL, true);
        for (const path of paths) this.invalidate(path);
        await this.ctx.storage.sync();
      }
      await host.destroyForStop(epoch);
      await this.containerConnection?.close();
      await this.containerConnection?.closed;
      this.containerConnection = undefined;
      if ((await host.state()).running) throw new Error('The container is still running');
      return Response.json({available: true, status: 'stopped'}, {headers: {'cache-control': 'private, no-store'}});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'The container could not be stopped', code: 'CONTAINER_STOP_FAILED'}, {status: 409, headers: {'cache-control': 'private, no-store'}});
    } finally {
      if (held) await host!.finishStop(epoch);
      this.admission.finish(epoch);
      await this.ctx.storage.sync();
    }
  }

  /** The container size this workspace launches with; a change applies when the container next starts. */
  private containerInstance(): ContainerInstance {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_container (id INTEGER PRIMARY KEY CHECK (id = 1), instance TEXT NOT NULL)');
    const stored = this.ctx.storage.sql.exec<{instance: string}>('SELECT instance FROM weft_container WHERE id = 1').toArray()[0]?.instance;
    return (CONTAINER_INSTANCES as readonly string[]).includes(stored ?? '') ? stored as ContainerInstance : DEFAULT_INSTANCE;
  }
  private rememberInstance(instance: ContainerInstance): void {
    this.containerInstance();
    this.ctx.storage.sql.exec('INSERT INTO weft_container VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET instance = excluded.instance', instance);
  }

  /** Run one shell command; the response streams NDJSON `stdout`/`stderr` chunks and the final `exit`. */
  async exec(input: WorkspaceScope, request: {id: string; command: string; cwd: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string; sandbox?: ShellSandbox; container?: {instance: ContainerInstance}}): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) {
      return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    }
    if (!this.env.LOADER) return Response.json({error: 'This deployment has no Worker Loader for shell execution', code: 'EXEC_UNAVAILABLE'}, {status: 501});
    let cwd: string;
    try { cwd = workspacePath(request.cwd); }
    catch (error) { return Response.json({error: error instanceof Error ? error.message : 'Invalid working directory', code: 'FS_SANDBOX_DENIED'}, {status: 403}); }
    let sandbox: ShellSandbox;
    try {
      const mode = request.sandbox?.mode ?? 'workspace-write';
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new Error('Unknown sandbox mode');
      sandbox = {mode, root: workspacePath(request.sandbox?.root ?? '/workspace')};
    } catch (error) { return Response.json({error: error instanceof Error ? error.message : 'Invalid sandbox', code: 'FS_SANDBOX_DENIED'}, {status: 400}); }
    // The container applies file effects in its own filesystem and syncs them back, so only the worker
    // shell can refuse each one: read-only commands always run there.
    let backend: string | undefined;
    if (request.container && sandbox.mode !== 'read-only') {
      try {this.admission.assert();} catch (error) {return Response.json({error: (error as Error).message, code: 'CONTAINER_STOPPING'}, {status: 409});}
      if (!this.container) return Response.json({error: 'This deployment has no workspace container', code: 'EXEC_UNAVAILABLE'}, {status: 501});
      if (!(CONTAINER_INSTANCES as readonly string[]).includes(request.container.instance)) return Response.json({error: 'Unknown container size', code: 'EXEC_UNAVAILABLE'}, {status: 400});
      this.rememberInstance(request.container.instance);
      backend = CONTAINER_SHELL;
    }
    this.sandboxes.set(request.id, sandbox);
    // The container's idle timeout counts from its host's last request, so a container command keeps the host active while it runs.
    const touch = () => { void this.containerHost()?.touch().catch(() => { /* The next command touches again. */ }); };
    const keepAlive = backend === CONTAINER_SHELL ? setInterval(touch, CONTAINER_TOUCH_MS) : undefined;
    if (keepAlive) touch();
    const epoch = this.admission.epoch;
    const release = () => { this.sandboxes.delete(request.id); this.containerRuns.delete(request.id); clearInterval(keepAlive); };
    let run: import('@cloudflare/computer').WorkspaceRuntimeExecHandle<'utf8'>;
    try { const pending = this.files.runtime.exec(request.command, {
      id: request.id, cwd, encoding: 'utf8',
      ...(backend ? {backend} : {}),
      ...(request.timeoutMs !== undefined ? {timeoutMs: request.timeoutMs} : {}),
      ...(request.env ? {env: request.env} : {}),
      ...(request.stdin !== undefined ? {stdin: request.stdin} : {}),
    });
      if (backend === CONTAINER_SHELL) this.containerRuns.set(request.id, {run: pending, release});
      run = await pending;
      if (backend === CONTAINER_SHELL) {
        try {this.admission.assert(epoch);} catch (error) {await this.killExec(scope.data, request.id); throw error;}
      }
    } catch (error) { release(); throw error; }
    const body = run.pipeThrough(shellOutputFrames(backend === CONTAINER_SHELL, release));
    return new Response(body, {headers: {'content-type': 'application/x-ndjson', 'cache-control': 'private, no-store'}});
  }

  async killExec(input: WorkspaceScope, id: string): Promise<void> {
    const scope = workspaceScopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Workspace scope mismatch');
    await this.files.runtime.killExec(id, {signal: 'SIGKILL'}).catch(() => { /* The execution already settled. */ });
  }
  private invalidate(changed: string): void {
    for (const watcher of this.watchers.values()) {
      if (changed === watcher.path || changed.startsWith(watcher.path + '/')) watcher.invalidate();
    }
  }
  async call(input: WorkspaceScope, operation: WorkspaceOperation): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) {
      return Response.json({ error: 'Workspace scope does not match the addressed object', code: 'FS_SANDBOX_DENIED' }, { status: 403 });
    }
    const parsed = workspaceOperationSchema.safeParse(operation);
    if (!parsed.success) return Response.json({ error: 'Invalid workspace operation', code: 'FS_INVALID_OPERATION' }, { status: 400 });
    try {
      const value = this.files.execute(parsed.data);
      await this.ctx.storage.sync();
      if (parsed.data.type === 'write' || parsed.data.type === 'edit' || parsed.data.type === 'mkdir' || (parsed.data.type === 'sweep' && (value as {removed: number}).removed > 0)) {
        const changed = workspacePath(parsed.data.path);
        this.invalidate(changed);
      }
      if (value instanceof Uint8Array) return new Response(new Uint8Array(value).buffer, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
      return Response.json({ value }, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      const failure = error instanceof FsError ? error : new FsError('Workspace operation failed', 'FS_IO_ERROR');
      return Response.json({ error: failure.message, code: failure.code }, { status: fsStatus(failure.code) });
    }
  }
  /** One streaming RPC per file; chunk boundaries and persistence belong to this object. */
  async uploadAttachment(input: WorkspaceScope, sessionId: string, name: string | undefined, body: ReadableStream<Uint8Array>): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) {
      if (body instanceof ReadableStream) await body.cancel().catch(() => {});
      return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    }
    const begin = attachmentOperationSchema.safeParse({type: 'begin', sessionId, ...(name === undefined ? {} : {name})});
    if (!begin.success || !(body instanceof ReadableStream)) {
      if (body instanceof ReadableStream) await body.cancel().catch(() => {});
      return Response.json({error: 'Invalid upload metadata or body', code: 'ATTACHMENT_WRITE_FAILED'}, {status: 400});
    }
    const reader = body.getReader();
    let uploadId: string | undefined, committed = false;
    try {
      ({uploadId} = this.files.attachments.execute(begin.data) as {uploadId: string});
      const hash = createHash('sha256');
      let offset = 0, used = 0;
      const buffer = new Uint8Array(UPLOAD_CHUNK_BYTES);
      const append = async () => {
        const data = buffer.subarray(0, used);
        this.files.attachments.execute({type: 'append', sessionId, uploadId: uploadId!, offset, data});
        hash.update(data); offset += used; used = 0;
        await this.ctx.storage.sync();
      };
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        for (let start = 0; start < value.byteLength;) {
          const take = Math.min(buffer.byteLength - used, value.byteLength - start);
          buffer.set(value.subarray(start, start + take), used); used += take; start += take;
          if (used === buffer.byteLength) await append();
        }
      }
      if (used) await append();
      const ref = this.files.attachments.execute({type: 'commit', sessionId, uploadId, sha256: hash.digest('hex')}) as FileAttachmentRef;
      await this.ctx.storage.sync(); committed = true;
      this.invalidate(storedFilePath(ATTACHMENT_ROOT, ref));
      return Response.json({value: ref}, {headers: {'cache-control': 'private, no-store'}});
    } catch (error) {
      const failure = error instanceof AttachmentError ? error : new AttachmentError('Attachment stream failed.', 'ATTACHMENT_WRITE_FAILED');
      return Response.json({error: failure.message, code: failure.code}, {status: failure.code === 'ATTACHMENT_NOT_FOUND' ? 404 : 400});
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock();
      if (uploadId && !committed) {
        try {this.files.attachments.execute({type: 'abort', sessionId, uploadId}); await this.ctx.storage.sync();} catch {}
      }
    }
  }
  async readAttachment(input: WorkspaceScope, ref: FileAttachmentRef): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    const parsed = attachmentOperationSchema.safeParse({type: 'read', ref, offset: 0});
    if (!parsed.success) return Response.json({error: 'Invalid file reference', code: 'ATTACHMENT_READ_FAILED'}, {status: 400});
    try {
      let first = this.files.attachments.execute(parsed.data) as Uint8Array;
      let offset = 0;
      const hash = createHash('sha256');
      const body = new ReadableStream<Uint8Array>({
        type: 'bytes',
        pull: controller => {
          try {
            const data = offset === 0 ? first : this.files.attachments.execute({type: 'read', ref, offset}) as Uint8Array;
            first = new Uint8Array(); hash.update(data); offset += data.byteLength;
            if (offset >= ref.bytes) {
              if (offset !== ref.bytes || 'sha256:' + hash.digest('hex') !== ref.attachmentId) throw new AttachmentError('Stored file failed integrity verification.', 'ATTACHMENT_CORRUPT');
              if (data.byteLength) controller.enqueue(new Uint8Array(data));
              controller.close();
            } else controller.enqueue(new Uint8Array(data));
          } catch (error) {controller.error(error);}
        },
      }, {highWaterMark: 0});
      return new Response(body, {headers: {'content-type': 'application/octet-stream', 'cache-control': 'private, no-store'}});
    } catch (error) {
      const failure = error instanceof AttachmentError ? error : new AttachmentError('Attachment read failed.', 'ATTACHMENT_READ_FAILED');
      return Response.json({error: failure.message, code: failure.code}, {status: failure.code === 'ATTACHMENT_NOT_FOUND' ? 404 : 400});
    }
  }
  async imageVariant(input: WorkspaceScope, key: string, candidate?: ImageVariantRecord): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    try {
      const value = this.files.imageVariants.resolve(key, candidate);
      await this.ctx.storage.sync();
      return Response.json({value}, {headers: {'cache-control': 'private, no-store'}});
    } catch (error) {
      const failure = error instanceof AttachmentError ? error : new AttachmentError('Image variant storage failed.', 'ATTACHMENT_WRITE_FAILED');
      return Response.json({error: failure.message, code: failure.code}, {status: 400});
    }
  }
  /** Private, bounded invalidations. The original WorkspaceChangeFeed reads current metadata. */
  async changes(input: WorkspaceScope, rawPath: string): Promise<Response> {
    const scope = workspaceScopeSchema.safeParse(input);
    if (!scope.success || !this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope.data)))) {
      return Response.json({error: 'Workspace scope mismatch', code: 'FS_SANDBOX_DENIED'}, {status: 403});
    }
    let path: string;
    try {
      path = workspacePath(rawPath);
      this.files.execute(workspaceOperationSchema.parse({type: 'stat', path}));
    } catch (error) {
      const failure = error instanceof FsError ? error : new FsError('Invalid workspace watch', 'FS_IO_ERROR');
      return Response.json({error: failure.message, code: failure.code}, {status: fsStatus(failure.code)});
    }
    if (this.watchers.size >= 32) return Response.json({error: 'Workspace observer limit reached', code: 'FS_IO_ERROR'}, {status: 429});
    let ready = true, pending = false, closed = false, wake: (() => void) | undefined;
    const watchId = crypto.randomUUID();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const watcher = {
      path, invalidate() {pending = true; wake?.();},
      close: (endStream = true) => {
        if (closed) return;
        closed = true; this.watchers.delete(watchId); wake?.();
        if (endStream) controller?.close();
      },
    };
    this.watchers.set(watchId, watcher);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(value) {controller = value;},
      async pull(controller) {
        if (ready) {ready = false; controller.enqueue(encoder.encode('ready\n')); return;}
        if (!pending && !closed) await new Promise<void>(resolve => {wake = resolve;});
        wake = undefined;
        if (closed) return;
        pending = false;
        controller.enqueue(encoder.encode('change\n'));
      },
      cancel: () => watcher.close(false),
    }, {highWaterMark: 0});
    return new Response(body, {headers: {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store', 'x-weft-watch-id': watchId}});
  }
  async closeChanges(input: WorkspaceScope, watchId: string): Promise<void> {
    const scope = workspaceScopeSchema.parse(input);
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Workspace scope mismatch');
    this.watchers.get(watchId)?.close();
  }
}
