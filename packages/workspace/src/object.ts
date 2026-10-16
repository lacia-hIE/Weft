import { DurableObject } from 'cloudflare:workers';
import { FsError } from '@deepseek-ai/dsh-fs';
import { WorkspaceStore } from './store.ts';
import { fsStatus, workspaceAddress, workspaceScopeSchema, workspaceOperationSchema, type WorkspaceScope, type WorkspaceOperation } from './protocol.ts';

interface Env { WORKSPACES: DurableObjectNamespace<WorkspaceDO> }
/** No unscoped Computer stub is exposed to clients or model tools. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly files: WorkspaceStore;
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
      if (value instanceof Uint8Array) return new Response(new Uint8Array(value).buffer, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
      return Response.json({ value }, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      const failure = error instanceof FsError ? error : new FsError('Workspace operation failed', 'FS_IO_ERROR');
      return Response.json({ error: failure.message, code: failure.code }, { status: fsStatus(failure.code) });
    }
  }
}
