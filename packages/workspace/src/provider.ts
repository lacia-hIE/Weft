import { posix } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import FileSystem, { FsError, FsTargetKey, FsVersion, type FsTarget, type FsInfo, type FsPathInfo, type FsDirEntry, type FsWriteIntent, type FsWriteOutcome, type FsEditRequest, type FsEditOutcome, type FsErrorCode } from '@deepseek-ai/dsh-fs';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { workspaceAddress, workspacePath, ROOT, MAX_BYTE_RANGE_BYTES, MAX_BINARY_FILE_BYTES, type WorkspaceScope, type WorkspaceTransport, type WorkspaceOperation, type FileInfo, type FileRead, type WriteResult, type SearchResult } from './protocol.ts';

interface ProviderConfig { scope: WorkspaceScope; transport: WorkspaceTransport; cwd?: string; listLimit?: number; readImage?: boolean }
export class ComputerFileSystem extends FileSystem {
  private readonly watchBacklogs = new Map<string, Set<{pending: number}>>();
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
    if (!path || path.length > 2048 || /[\\\0\r\n]/.test(path)) throw new FsError('Invalid workspace path', 'FS_SANDBOX_DENIED');
    // Paths above the volume resolve so read-only probes (project-root markers)
    // observe them as absent; every content operation still rejects them.
    const canonical = posix.resolve(workspacePath('.', opts?.cwd ?? this.config.cwd), path);
    return { targetKey: FsTargetKey(this.key(canonical)), displayPath: canonical };
  }
  private inside(target: FsTarget): boolean { return target.displayPath === ROOT || target.displayPath.startsWith(ROOT + '/'); }
  override processPath(target: FsTarget): string { return this.path(target); }
  override processPathFromHostPath(hostPath: string): string | undefined {
    try {return workspacePath(hostPath);} catch {return undefined;}
  }
  override fileUrl(target: FsTarget): string { return `file://${this.path(target).split('/').map(encodeURIComponent).join('/')}`; }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const root = this.path(parent), path = this.path(child);
    return root === path || path.startsWith(root + '/');
  }
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (!this.inside(target)) {
      if (target.targetKey !== this.key(target.displayPath)) throw new FsError('Target belongs to another workspace', 'FS_SANDBOX_DENIED');
      return undefined;
    }
    const info = await this.call<FileInfo | null>({ type: 'stat', path: this.path(target) }, signal);
    for (const backlog of this.watchBacklogs.get(target.targetKey) ?? []) backlog.pending = 0;
    return info ? { version: FsVersion(info.version), type: info.type, size: info.size } : undefined;
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.stat(await this.resolve(path, { ...opts, ...(signal ? { signal } : {}) }), signal);
  }
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return (await this.call<FileRead>({ type: 'read', path: this.path(target) }, signal)).content;
  }
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const fs = this;
    return (async function* () {
      const decoder = new TextDecoder('utf-8', {fatal: true});
      for (let offset = 0;; offset += 16_384) {
        const bytes = await fs.bytes(target, {offset, length: 16_384}, signal);
        let text: string;
        try { text = decoder.decode(bytes, {stream: bytes.length === 16_384}); }
        catch { throw new FsError('Workspace file is not UTF-8 text', 'FS_NOT_TEXT'); }
        if (text) yield text;
        if (bytes.length < 16_384) return;
      }
    })();
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
    const limit = Math.min(maxBytes, MAX_BINARY_FILE_BYTES);
    return this.bytes(target, { offset: 0, length: limit, maxBytes: limit }, signal);
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0) throw new FsError('Invalid byte range', 'FS_IO_ERROR');
    if (range.length > MAX_BYTE_RANGE_BYTES || range.offset + range.length > Number.MAX_SAFE_INTEGER) throw new FsError('Read exceeds the byte limit', 'FS_TOO_LARGE');
    return this.bytes(target, range, signal);
  }
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.call<FileInfo[]>({ type: 'list', path: this.path(target), ...(this.config.listLimit ? {limit: this.config.listLimit} : {}) }, signal);
    return entries.map(info => ({ name: posix.basename(info.path), type: info.type, target: { displayPath: info.path, targetKey: FsTargetKey(this.key(info.path)) }, size: info.size, version: FsVersion(info.version) }));
  }
  /** Confines like the shell: the composed sandbox policy decides each write's mode. */
  override get sandboxMode() { return this.ctx.get('sandboxPolicy')?.defaultMode; }
  private confine(path: string, policy?: SandboxExecutionPolicy): void {
    if (!policy || policy.mode === 'danger-full-access') return;
    if (policy.mode === 'read-only') throw new FsError(`${path}: blocked by the read-only sandbox`, 'FS_SANDBOX_DENIED');
    const root = workspacePath(policy.workspaceRoot);
    if (path !== root && !path.startsWith(root + '/')) throw new FsError(`${path}: blocked by the workspace-write sandbox (writable: ${root})`, 'FS_SANDBOX_DENIED');
  }
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
    this.confine(this.path(target), sandboxPolicy);
    const result = await this.call<WriteResult>({ type: 'write', path: this.path(target), content, ...(expected ? { expected } : {}) }, signal);
    return { operation: result.operation, version: FsVersion(result.version), before: result.before, after: result.after };
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
    this.confine(this.path(target), sandboxPolicy);
    const result = await this.call<WriteResult>({ type: 'edit', path: this.path(target), ...edit, ...(expected ? { expectedVersion: expected.version } : {}) }, signal);
    return { version: FsVersion(result.version), before: result.before!, after: result.after };
  }
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted();
    if (!this.config.transport.changes) throw new FsError('Workspace watching is unavailable', 'FS_IO_ERROR');
    const response = await this.config.transport.changes(this.config.scope, this.path(target));
    if (!response.ok) {
      const failure = await response.json() as {error: string; code: FsErrorCode};
      throw new FsError(failure.error, failure.code);
    }
    if (!response.body) throw new FsError('Workspace watch has no body', 'FS_IO_ERROR');
    const watchId = response.headers.get('x-weft-watch-id');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const backlog = {pending: 0};
    const backlogs = this.watchBacklogs.get(target.targetKey) ?? new Set<{pending: number}>();
    backlogs.add(backlog); this.watchBacklogs.set(target.targetKey, backlogs);
    let pending = '', closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      backlogs.delete(backlog);
      if (!backlogs.size) this.watchBacklogs.delete(target.targetKey);
      signal.removeEventListener('abort', aborted);
      await Promise.all([
        reader.cancel(),
        ...(watchId && this.config.transport.closeChanges ? [this.config.transport.closeChanges(this.config.scope, watchId)] : []),
      ]);
    };
    const aborted = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', aborted, {once: true});
    const frame = async (): Promise<string> => {
      for (;;) {
        const end = pending.indexOf('\n');
        if (end >= 0) { const value = pending.slice(0, end); pending = pending.slice(end + 1); return value; }
        const next = await reader.read();
        if (next.done) throw new FsError('Workspace watch ended; reconnect to refresh', 'FS_IO_ERROR');
        pending += next.value;
        if (pending.length > 64) throw new FsError('Invalid workspace watch frame', 'FS_IO_ERROR');
      }
    };
    try {
      signal.throwIfAborted();
      if (await frame() !== 'ready') throw new FsError('Workspace watch did not initialize', 'FS_IO_ERROR');
      signal.throwIfAborted();
    } catch (error) { await close(); throw error; }
    void (async () => {
      try {
        while (!closed) {
          if (await frame() !== 'change') throw new FsError('Invalid workspace watch frame', 'FS_IO_ERROR');
          if (++backlog.pending > 64) throw new FsError('File observer backlog exceeded; reconnect to refresh', 'FS_IO_ERROR');
          if (!closed) changed();
        }
      } catch (error) {
        if (!closed) changed(error instanceof Error ? error : new FsError('Workspace watch failed', 'FS_IO_ERROR'));
      } finally { await close().catch(() => {}); }
    })();
    return close;
  }
}

/** Keep upstream tool schemas, read windows, observation policy, rendering and diff behavior. */
export async function mountWorkspace(ctx: Context, config: ProviderConfig): Promise<void> {
  await ctx.plugin(ComputerFileSystem, config);
  const cwd = config.cwd ?? ROOT;
  await ctx.plugin(WorkingDirectory, { defaultDirectory: cwd });
  await ctx.plugin(ObservationPolicy);
  await ctx.plugin(FileTools, {readImage: config.readImage ?? false});
  ctx.tools.register(defineTool({
    name: 'workspace_search', description: 'Search literal text within the attached workspace. Returns bounded matching lines.',
    parameters: { query: { type: 'string', required: true }, path: { type: 'string', description: 'Directory or file under /workspace. Defaults to /workspace.' } },
    output: { schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    execute: async (args: { query: string; path?: string }, exec) => {
      exec.signal.throwIfAborted();
      const response = await config.transport.call(config.scope, { type: 'search', path: workspacePath(args.path ?? cwd, cwd), query: args.query, limit: 50 });
      const payload = await response.json() as { value?: SearchResult; error?: string; code?: FsErrorCode };
      exec.signal.throwIfAborted();
      if (!response.ok) throw new FsError(payload.error ?? 'Workspace search failed', payload.code ?? 'FS_IO_ERROR');
      return { result: JSON.stringify(payload.value) };
    },
  }));
}
