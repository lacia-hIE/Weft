import worker, {WorkspaceDO as BaseWorkspaceDO, type Env} from '../../apps/worker/src/index.ts';
import {workspaceAddress, type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
import type {JavaScriptRequest} from '../../packages/workspace/src/javascript.ts';
export * from '../../apps/worker/src/index.ts';

/** Time/log manipulation is available only in this private CI Worker fixture. */
export class WorkspaceDO extends BaseWorkspaceDO {
  private readonly testStorage: DurableObjectStorage;
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, env); this.testStorage = ctx.storage;}
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/_test/task-maintenance') return super.fetch(request);
    const {id, kind} = await request.json() as {id: string; kind: 'expire' | 'lose-log'};
    if (kind === 'expire') this.testStorage.sql.exec('UPDATE weft_javascript_jobs SET expires_at=? WHERE id=?', Date.now() - 1, id);
    else {
      this.testStorage.sql.exec('DELETE FROM workspace_runtime_events WHERE execution_id=?', id);
      this.testStorage.sql.exec('DELETE FROM workspace_runtime_executions WHERE id=?', id);
      this.testStorage.sql.exec("UPDATE weft_javascript_jobs SET snapshot=NULL,state='running' WHERE id=?", id);
    }
    return new Response(null, {status: 204});
  }
}

/** Private test transport to the genuine WorkspaceDO; never built into the deployment Worker. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/_test/task-maintenance') {
      const raw = await request.json() as {scope: WorkspaceScope; id: string; kind: string};
      return env.WORKSPACES.getByName(workspaceAddress(raw.scope)).fetch(new Request('https://workspace.internal/_test/task-maintenance', {method: 'POST', body: JSON.stringify(raw)}));
    }
    if (new URL(request.url).pathname !== '/_test/javascript') return worker.fetch(request, env, ctx);
    const {scope, addressScope = scope, owner, operation} = await request.json() as {scope: WorkspaceScope; addressScope?: WorkspaceScope; owner: string; operation: JavaScriptRequest};
    try {return await env.WORKSPACES.getByName(workspaceAddress(addressScope)).javascript(scope, owner, operation);}
    catch (error) {return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 400});}
  },
};
