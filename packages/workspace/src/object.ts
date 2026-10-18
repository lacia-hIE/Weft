import {createHash} from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { FsError } from '@deepseek-ai/dsh-fs';
import { WorkspaceStore } from './store.ts';
import { fsStatus, workspaceAddress, workspaceScopeSchema, workspaceOperationSchema, workspacePath, type WorkspaceScope, type WorkspaceOperation } from './protocol.ts';
import {AttachmentError, type FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {attachmentOperationSchema, ATTACHMENT_ROOT, UPLOAD_CHUNK_BYTES} from '../../native-attachments/src/storage.ts';
import {storedFilePath} from '../../../.generated/official-file-reference.ts';

interface Env { WORKSPACES: DurableObjectNamespace<WorkspaceDO> }
/** No unscoped Computer stub is exposed to clients or model tools. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly files: WorkspaceStore;
  private readonly watchers = new Map<string, {path: string; invalidate(): void; close(endStream?: boolean): void}>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new WorkspaceStore(ctx.storage);
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
      if (parsed.data.type === 'write' || parsed.data.type === 'edit' || parsed.data.type === 'mkdir') {
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
