import worker, {type Env} from '../../apps/worker/src/index.ts';
import {workspaceAddress, type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
import type {JavaScriptRequest} from '../../packages/workspace/src/javascript.ts';
export * from '../../apps/worker/src/index.ts';

/** Private test transport to the genuine WorkspaceDO; never built into the deployment Worker. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== '/_test/javascript') return worker.fetch(request, env, ctx);
    const {scope, addressScope = scope, owner, operation} = await request.json() as {scope: WorkspaceScope; addressScope?: WorkspaceScope; owner: string; operation: JavaScriptRequest};
    try {return Response.json(await env.WORKSPACES.getByName(workspaceAddress(addressScope)).javascript(scope, owner, operation));}
    catch (error) {return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 400});}
  },
};
