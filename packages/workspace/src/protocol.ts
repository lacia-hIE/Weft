import { posix } from 'node:path';
import { z } from 'zod';
import { FsError } from '@deepseek-ai/dsh-fs';

export const workspaceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const workspaceScopeSchema = z.object({ tenantId: workspaceIdSchema, workspaceId: workspaceIdSchema, environmentId: workspaceIdSchema.optional() }).strict();
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;
export const ROOT = '/workspace';
export const MAX_FILE_BYTES = 256 * 1024;
const path = z.string().min(1).max(2048);
const version = z.string().min(1).max(100);
const intent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createIfAbsent') }).strict(),
  z.object({ kind: z.literal('replaceIfVersion'), version }).strict(),
]);
export const workspaceOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stat'), path }).strict(),
  z.object({ type: z.literal('read'), path }).strict(),
  z.object({ type: z.literal('list'), path }).strict(),
  z.object({ type: z.literal('bytes'), path, offset: z.number().int().min(0), length: z.number().int().min(0).max(MAX_FILE_BYTES), maxBytes: z.number().int().min(0).max(MAX_FILE_BYTES).optional() }).strict(),
  z.object({ type: z.literal('write'), path, content: z.string().max(MAX_FILE_BYTES), expected: intent.optional() }).strict(),
  z.object({ type: z.literal('edit'), path, oldString: z.string().min(1).max(MAX_FILE_BYTES), newString: z.string().max(MAX_FILE_BYTES), replaceAll: z.boolean(), expectedVersion: version.optional() }).strict(),
  z.object({ type: z.literal('search'), path, query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(100).default(50) }).strict(),
]);
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export interface FileInfo { path: string; type: 'file' | 'directory'; size: number; version: string }
export interface FileRead extends FileInfo { content: string }
export interface WriteResult { operation: 'create' | 'update'; version: string; before: string | null; after: string; revision: number }
export interface SearchResult { matches: { path: string; line: number; text: string }[]; truncated: boolean }
export interface WorkspaceTransport { call(scope: WorkspaceScope, operation: WorkspaceOperation): Promise<Response> }

export function workspaceAddress(scope: WorkspaceScope): string { return JSON.stringify(scope.environmentId && scope.environmentId !== "default" ? [scope.tenantId, "environment", scope.environmentId, scope.workspaceId] : [scope.tenantId, scope.workspaceId]); }
export function workspacePath(path: string, cwd = ROOT): string {
  if (!path || path.length > 2048 || /[\\\0\r\n]/.test(path)) throw new FsError('Invalid workspace path', 'FS_SANDBOX_DENIED');
  const result = posix.resolve(cwd, path);
  if (result !== ROOT && !result.startsWith(ROOT + '/')) throw new FsError('Path is outside the workspace', 'FS_SANDBOX_DENIED');
  return result;
}
export function fsStatus(code: string): number {
  if (code === 'FS_NOT_FOUND') return 404;
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED' || code === 'FS_AMBIGUOUS_EDIT') return 409;
  if (code === 'FS_SANDBOX_DENIED' || code === 'FS_PERMISSION_DENIED') return 403;
  if (code === 'FS_TOO_LARGE') return 413;
  return code === 'FS_IO_ERROR' ? 500 : 400;
}
