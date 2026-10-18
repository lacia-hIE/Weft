import { DurableObject } from 'cloudflare:workers';
import { FsError } from '@deepseek-ai/dsh-fs';
import { WorkspaceStore } from './store.ts';
import { fsStatus, workspaceAddress, workspaceScopeSchema, workspaceOperationSchema, workspacePath, type WorkspaceScope, type WorkspaceOperation } from './protocol.ts';

interface Env { WORKSPACES: DurableObjectNamespace<WorkspaceDO> }
/** No unscoped Computer stub is exposed to clients or model tools. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly files: WorkspaceStore;
  private readonly watchers = new Map<string, {path: string; invalidate(): void; close(endStream?: boolean): void}>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new WorkspaceStore(ctx.storage);
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
      if (parsed.data.type === 'write' || parsed.data.type === 'edit' || parsed.data.type === 'mkdir') {
        const changed = workspacePath(parsed.data.path);
        for (const watcher of this.watchers.values()) {
          if (changed === watcher.path || changed.startsWith(watcher.path + '/')) watcher.invalidate();
        }
      }
      if (value instanceof Uint8Array) return new Response(new Uint8Array(value).buffer, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
      return Response.json({ value }, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      const failure = error instanceof FsError ? error : new FsError('Workspace operation failed', 'FS_IO_ERROR');
      return Response.json({ error: failure.message, code: failure.code }, { status: fsStatus(failure.code) });
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
