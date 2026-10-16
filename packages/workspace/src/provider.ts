import { posix } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import FileSystem, { FsError, FsTargetKey, FsVersion, type FsTarget, type FsInfo, type FsPathInfo, type FsDirEntry, type FsWriteIntent, type FsWriteOutcome, type FsEditRequest, type FsEditOutcome, type FsErrorCode } from '@deepseek-ai/dsh-fs';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceAddress, workspacePath, ROOT, MAX_FILE_BYTES, type WorkspaceScope, type WorkspaceTransport, type WorkspaceOperation, type FileInfo, type FileRead, type WriteResult, type SearchResult } from './protocol.ts';

interface ProviderConfig { scope: WorkspaceScope; transport: WorkspaceTransport }
export class ComputerFileSystem extends FileSystem {
  constructor(ctx: Context, private readonly config: ProviderConfig) { super(ctx); }
  private async call<T>(operation: WorkspaceOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const response = await this.config.transport.call(this.config.scope, operation);
    const payload = await response.json() as { value: T; code?: FsErrorCode; error?: string };
    signal?.throwIfAborted();
    if (!response.ok) throw new FsError(payload.error ?? 'Workspace operation failed', payload.code ?? 'FS_IO_ERROR');
    return payload.value;
  }
  private key(path: string): string { return JSON.stringify([workspaceAddress(this.config.scope), path]); }
  private path(target: FsTarget): string {
    const path = workspacePath(target.displayPath);
    if (target.targetKey !== this.key(path)) throw new FsError('Target belongs to another workspace', 'FS_SANDBOX_DENIED');
    return path;
  }
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted();
    const canonical = workspacePath(path, opts?.cwd);
    return { targetKey: FsTargetKey(this.key(canonical)), displayPath: canonical };
  }
  override processPath(target: FsTarget): string { return this.path(target); }
  override fileUrl(target: FsTarget): string { return `file://${this.path(target).split('/').map(encodeURIComponent).join('/')}`; }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const root = this.path(parent), path = this.path(child);
    return root === path || path.startsWith(root + '/');
  }
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.call<FileInfo | null>({ type: 'stat', path: this.path(target) }, signal);
    return info ? { version: FsVersion(info.version), type: info.type, size: info.size } : undefined;
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.stat(await this.resolve(path, { ...opts, ...(signal ? { signal } : {}) }), signal);
  }
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return (await this.call<FileRead>({ type: 'read', path: this.path(target) }, signal)).content;
  }
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const content = await this.readText(target, signal);
    return (async function* () { for (let offset = 0; offset < content.length; offset += 8192) { signal?.throwIfAborted(); yield content.slice(offset, offset + 8192); } })();
  }
  private async bytes(target: FsTarget, range: { offset: number; length: number; maxBytes?: number }, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const response = await this.config.transport.call(this.config.scope, { type: 'bytes', path: this.path(target), ...range });
    if (!response.ok) {
      const error = await response.json() as { error: string; code: FsErrorCode };
      throw new FsError(error.error, error.code);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    return bytes;
  }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError('Invalid read bound', 'FS_IO_ERROR');
    return this.bytes(target, { offset: 0, length: MAX_FILE_BYTES, maxBytes: Math.min(maxBytes, MAX_FILE_BYTES) }, signal);
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0) throw new FsError('Invalid byte range', 'FS_IO_ERROR');
    if (range.length > MAX_FILE_BYTES) throw new FsError('Read exceeds the byte limit', 'FS_TOO_LARGE');
    return this.bytes(target, range, signal);
  }
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.call<FileInfo[]>({ type: 'list', path: this.path(target) }, signal);
    return entries.map(info => ({ name: posix.basename(info.path), type: info.type, target: { displayPath: info.path, targetKey: FsTargetKey(this.key(info.path)) }, size: info.size, version: FsVersion(info.version) }));
  }
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const result = await this.call<WriteResult>({ type: 'write', path: this.path(target), content, ...(expected ? { expected } : {}) }, signal);
    return { operation: result.operation, version: FsVersion(result.version), before: result.before, after: result.after };
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    const result = await this.call<WriteResult>({ type: 'edit', path: this.path(target), ...edit, ...(expected ? { expectedVersion: expected.version } : {}) }, signal);
    return { version: FsVersion(result.version), before: result.before!, after: result.after };
  }
}

/** Keep upstream tool schemas, read windows, observation policy, rendering and diff behavior. */
export async function mountWorkspace(ctx: Context, config: ProviderConfig): Promise<void> {
  await ctx.plugin(ComputerFileSystem, config);
  await ctx.plugin(WorkingDirectory, { defaultDirectory: ROOT });
  await ctx.plugin(ObservationPolicy);
  await ctx.plugin(FileTools, { readImage: false });
  ctx.tools.register(defineTool({
    name: 'workspace_search', description: 'Search literal text within the attached workspace. Returns bounded matching lines.',
    parameters: { query: { type: 'string', required: true }, path: { type: 'string', description: 'Directory or file under /workspace. Defaults to /workspace.' } },
    output: { schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    execute: async (args: { query: string; path?: string }, exec) => {
      exec.signal.throwIfAborted();
      const response = await config.transport.call(config.scope, { type: 'search', path: workspacePath(args.path ?? ROOT), query: args.query, limit: 50 });
      const payload = await response.json() as { value?: SearchResult; error?: string; code?: FsErrorCode };
      exec.signal.throwIfAborted();
      if (!response.ok) throw new FsError(payload.error ?? 'Workspace search failed', payload.code ?? 'FS_IO_ERROR');
      return { result: JSON.stringify(payload.value) };
    },
  }));
}
