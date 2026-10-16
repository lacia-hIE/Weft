import { z } from 'zod';
import type { Env } from './index.ts';
import type { Principal } from '../../../packages/tenant/src/index.ts';
import { workspaceScopeSchema, workspaceAddress, ROOT, MAX_FILE_BYTES, type WorkspaceOperation, type FileInfo } from '../../../packages/workspace/src/protocol.ts';
import { HttpError, readJson, assertSameOrigin } from './http.ts';

const writeSchema = z.object({ path: z.string().min(1).max(2048), content: z.string().max(MAX_FILE_BYTES), expectedVersion: z.string().min(1).max(100).nullable() }).strict();
const editSchema = z.object({ path: z.string().min(1).max(2048), oldString: z.string().min(1).max(MAX_FILE_BYTES), newString: z.string().max(MAX_FILE_BYTES), replaceAll: z.boolean().default(false), expectedVersion: z.string().min(1).max(100) }).strict();

export async function handleWorkspaceRequest(request: Request, env: Env, principal: Principal, environmentId?: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/v1\/tenants\/([^/]+)\/workspaces\/([^/]+)\/(files|search)$/.exec(url.pathname);
  if (!match) return undefined;
  const parsed = workspaceScopeSchema.safeParse({ tenantId: match[1], workspaceId: match[2], ...(environmentId ? { environmentId } : {}) });
  if (!parsed.success) throw new HttpError(400, 'Invalid workspace identity');
  const scope = parsed.data;
  if (scope.tenantId !== principal.tenantId) throw new HttpError(403, 'Tenant access denied');
  const workspace = env.WORKSPACES.getByName(workspaceAddress(scope));
  let operation: WorkspaceOperation;
  if (request.method === 'GET') {
    const path = url.searchParams.get('path') ?? ROOT;
    if (match[3] === 'search') {
      const query = url.searchParams.get('query');
      if (!query || query.length > 1000) throw new HttpError(400, 'Invalid search query');
      operation = { type: 'search', path, query, limit: 50 };
    } else {
      const response = await workspace.call(scope, { type: 'stat', path });
      if (!response.ok) return response;
      const { value } = await response.json() as { value: FileInfo | null };
      if (!value) throw new HttpError(404, 'Workspace entry not found');
      operation = { type: value.type === 'directory' ? 'list' : 'read', path };
    }
  } else if (match[3] === 'files' && (request.method === 'PUT' || request.method === 'PATCH')) {
    assertSameOrigin(request);
    const raw = await readJson(request, 2 * 1024 * 1024);
    if (request.method === 'PUT') {
      const body = writeSchema.safeParse(raw);
      if (!body.success) throw new HttpError(400, 'Expected path, content and expectedVersion (null creates a new file)');
      operation = { type: 'write', path: body.data.path, content: body.data.content, expected: body.data.expectedVersion === null
        ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: body.data.expectedVersion } };
    } else {
      const body = editSchema.safeParse(raw);
      if (!body.success) throw new HttpError(400, 'Invalid file edit; expectedVersion is required');
      operation = { type: 'edit', ...body.data };
    }
  } else return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { allow: match[3] === 'files' ? 'GET, PUT, PATCH' : 'GET' } });
  return await workspace.call(scope, operation);
}
