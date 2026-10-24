import { posix } from 'node:path';
import { Workspace, type WorkspaceObserver, type WorkspaceRegisteredBackend } from '@cloudflare/computer';
import { FsError } from '@deepseek-ai/dsh-fs';
import { ROOT, MAX_FILE_BYTES, SPILL_ROOT as SWEEP_ROOT, workspacePath, type FileInfo, type FileRead, type WriteResult, type SearchResult, type WorkspaceOperation } from './protocol.ts';
import {ComputerImageVariants} from '../../native-attachments/src/image-variants.ts';
import {ComputerAttachmentFiles, ATTACHMENT_PRIVATE_ROOT} from '../../native-attachments/src/storage.ts';
import {WorkspaceCopy} from './copy.ts';

/** Computer owns file bytes; Weft owns monotone versions and the exposed capability boundary. */
export class WorkspaceStore {
  private readonly computer: Workspace;
  readonly attachments: ComputerAttachmentFiles;
  readonly imageVariants: ComputerImageVariants;
  readonly copies: WorkspaceCopy;
  constructor(private readonly storage: DurableObjectStorage, execution?: {backends: WorkspaceRegisteredBackend[]; observer: WorkspaceObserver}) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_workspace_schema (version INTEGER NOT NULL)');
    const versions = storage.sql.exec<{ version: number }>('SELECT version FROM weft_workspace_schema').toArray();
    if (versions.length > 1 || (versions[0] && versions[0].version !== 1)) throw new Error('Unsupported Weft workspace format');
    storage.transactionSync(() => {
      if (!versions.length) storage.sql.exec('INSERT INTO weft_workspace_schema VALUES (1)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)');
      storage.sql.exec('INSERT OR IGNORE INTO weft_workspace_state VALUES (1, 0)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_file_versions (path TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    });
    this.computer = new Workspace({ storage, output: false, ...(execution ? {backends: execution.backends, observer: execution.observer} : {}) });
    this.computer.provider().mkdirSync(ROOT, { recursive: true });
    this.copies = new WorkspaceCopy(storage, this.computer.provider());
    // Shell scratch space; the execution policy allows writes there besides the workspace volume.
    if (execution) this.computer.provider().mkdirSync('/tmp', { recursive: true });
    this.attachments = new ComputerAttachmentFiles(storage, this.computer.provider(), path => {this.version(path);});
    this.imageVariants = new ComputerImageVariants(storage, file => {this.attachments.execute({type: 'read', ref: file, offset: 0});});
  }

  /** The Computer runtime that executes shell commands against these same files. */
  get runtime() { return this.computer.runtime; }

  /** Sync changes made by the independent process daemon; keep Weft file versions authoritative. */
  async synchronize(backend: string, pull: boolean): Promise<string[]> {
    const before = this.storage.sql.exec<{v: number}>("SELECT v FROM vfs_meta WHERE k='rev'").one().v;
    if (pull) for await (const block of this.computer.pull(backend)) {
      if (block.skipped) throw new Error('Container file synchronization skipped conflicting or protected paths');
    }
    const after = this.storage.sql.exec<{v: number}>("SELECT v FROM vfs_meta WHERE k='rev'").one().v;
    const paths = pull && after > before ? this.storage.sql.exec<{path: string; removed: number}>(`WITH RECURSIVE paths(inode,path) AS (
      SELECT 1,'/' UNION ALL SELECT d.child_inode,rtrim(p.path,'/')||'/'||d.name FROM paths p JOIN vfs_dirents d ON d.parent_inode=p.inode
    ) SELECT p.path,0 AS removed FROM paths p JOIN vfs_nodes n ON n.inode=p.inode WHERE n.rev>?
      UNION SELECT path,1 AS removed FROM vfs_changes WHERE rev>? AND op='delete'`, before, before).toArray()
      .filter(row => row.path === ROOT || row.path.startsWith(ROOT + '/')) : [];
    if (paths.length) this.externalChanges(paths.map(row => ({path: row.path, removed: row.removed === 1})));
    for await (const block of this.computer.push(backend)) {
      if (block.skipped) throw new Error('Workspace file synchronization skipped conflicting or protected paths');
    }
    await this.storage.sync();
    return paths.map(row => row.path);
  }
  /** The Workspace RPC surface a Dynamic Worker backend reaches through `WorkspaceServiceProxy`. */
  async stub() { await this.computer.ready(); return this.computer.stub(); }

  /**
   * Record mutations made outside Weft's own operations (a shell execution):
   * changed paths get a new version, and removed subtrees drop theirs so
   * stale reads can never pass a version check.
   */
  externalChanges(changes: readonly {path: string; removed: boolean}[]): void {
    this.storage.transactionSync(() => {
      for (const change of changes) {
        if (change.removed) this.storage.sql.exec("DELETE FROM weft_file_versions WHERE path=? OR path LIKE ? ESCAPE '\\'", change.path, change.path.replace(/[\\%_]/g, '\\$&') + '/%');
        this.version(change.path);
      }
    });
  }

  private revision(): number { return this.storage.sql.exec<{ revision: number }>('SELECT revision FROM weft_workspace_state WHERE id=1').one().revision; }
  private version(path: string): number {
    const revision = this.revision() + 1;
    this.storage.sql.exec('UPDATE weft_workspace_state SET revision=? WHERE id=1', revision);
    this.storage.sql.exec('INSERT INTO weft_file_versions VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET version=excluded.version', path, revision);
    return revision;
  }
  private guardedPath(raw: string): string {
    const path = workspacePath(raw);
    let prefix = '';
    for (const component of path.split('/').filter(Boolean)) {
      prefix += '/' + component;
      try {
        if (this.computer.provider().lstatSync(prefix).isSymbolicLink()) throw new FsError('Workspace symlinks are not supported', 'FS_SANDBOX_DENIED');
      } catch (error) { if (this.code(error) === 'ENOENT') break; throw error; }
    }
    return path;
  }
  private code(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined; }
  private metadata(path: string): FileInfo | undefined {
    try {
      const stat = this.computer.provider().statSync(path);
      if (!stat.isFile() && !stat.isDirectory()) throw new FsError('Unsupported workspace entry', 'FS_NOT_REGULAR_FILE');
      const row = this.storage.sql.exec<{ version: number }>('SELECT version FROM weft_file_versions WHERE path=?', path).toArray()[0];
      return { path, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, version: row ? String(row.version) : `computer-${stat.ino}-${stat.mtimeMs}-${this.revision()}` };
    } catch (error) { if (this.code(error) === 'ENOENT') return undefined; throw error; }
  }
  /** Remove files older than `before` below `directory`, then the directories that empties; returns the files removed. */
  private sweep(directory: string, before: number, prune: boolean): number {
    const provider = this.computer.provider();
    let removed = 0;
    for (const name of provider.readdirSync(directory) as string[]) {
      const path = posix.join(directory, name);
      const stat = provider.statSync(path);
      if (stat.isDirectory()) removed += this.sweep(path, before, true);
      else if (stat.isFile() && stat.mtimeMs < before && name !== '.gitignore') {
        provider.unlinkSync(path);
        this.storage.sql.exec('DELETE FROM weft_file_versions WHERE path=?', path);
        removed++;
      }
    }
    if (prune && (provider.readdirSync(directory) as string[]).length === 0) provider.rmdirSync(directory);
    return removed;
  }
  private read(path: string): FileRead {
    const info = this.metadata(path);
    if (!info) throw new FsError('Workspace file not found', 'FS_NOT_FOUND');
    if (info.type !== 'file') throw new FsError('Expected a regular workspace file', 'FS_NOT_REGULAR_FILE');
    if (info.size > MAX_FILE_BYTES) throw new FsError('Workspace file exceeds the text limit', 'FS_TOO_LARGE');
    const bytes = this.computer.provider().readFileSync(path);
    if (typeof bytes === 'string') throw new FsError('Unexpected filesystem encoding', 'FS_IO_ERROR');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new FsError('Workspace file is not UTF-8 text', 'FS_NOT_TEXT'); }
    if (content.includes('\0')) throw new FsError('Workspace file is binary', 'FS_NOT_TEXT');
    return { ...info, content };
  }
  private write(path: string, after: string, before: string | null): WriteResult {
    if (after.includes('\0')) throw new FsError('Only UTF-8 text is supported', 'FS_NOT_TEXT');
    if (new TextEncoder().encode(after).byteLength > MAX_FILE_BYTES) throw new FsError('Workspace file exceeds the text limit', 'FS_TOO_LARGE');
    this.computer.provider().mkdirSync(posix.dirname(path), { recursive: true });
    this.computer.provider().writeFileSync(path, after, 'utf8');
    const revision = this.version(path);
    return { operation: before === null ? 'create' : 'update', before, after, version: String(revision), revision };
  }

  /** Every operation, including version checks and Computer mutations, shares one SQL transaction. */
  execute(operation: WorkspaceOperation): unknown {
    try {
      return this.storage.transactionSync(() => {
        const path = this.guardedPath(operation.path);
        if (['write', 'edit', 'mkdir'].includes(operation.type) && (path === ATTACHMENT_PRIVATE_ROOT || path.startsWith(ATTACHMENT_PRIVATE_ROOT+'/'))) throw new FsError('Attachment storage is immutable', 'FS_PERMISSION_DENIED');
        if (operation.type === 'stat') return this.metadata(path) ?? null;
        if (operation.type === 'read') return this.read(path);
        if (operation.type === 'mkdir') {
          if (this.metadata(path)) throw new FsError('Workspace entry already exists', 'FS_IO_ERROR');
          const parent = this.metadata(posix.dirname(path));
          if (parent?.type !== 'directory') throw new FsError('Parent directory not found', 'FS_NOT_DIRECTORY');
          this.computer.provider().mkdirSync(path);
          this.storage.sql.exec('UPDATE weft_workspace_state SET revision=revision+1 WHERE id=1');
          return this.metadata(path);
        }
        if (operation.type === 'sweep') {
          if (path !== SWEEP_ROOT && !path.startsWith(SWEEP_ROOT + '/')) throw new FsError('Only spilled output is swept', 'FS_SANDBOX_DENIED');
          return {removed: this.metadata(path)?.type === 'directory' ? this.sweep(path, operation.before, false) : 0};
        }
        if (operation.type === 'list') {
          const info = this.metadata(path);
          if (!info) throw new FsError('Workspace directory not found', 'FS_NOT_FOUND');
          if (info.type !== 'directory') throw new FsError('Expected a directory', 'FS_NOT_DIRECTORY');
          const names = this.computer.provider().readdirSync(path) as string[];
          if (operation.limit === undefined && names.length > 1000) throw new FsError('Directory listing exceeds the entry limit', 'FS_TOO_LARGE');
          return names.sort().slice(0, operation.limit ?? 1000).map(name => this.metadata(this.guardedPath(posix.join(path, name)))!);
        }
        if (operation.type === 'bytes') {
          const info = this.metadata(path);
          if (!info) throw new FsError('Workspace file not found', 'FS_NOT_FOUND');
          if (info.type !== 'file') throw new FsError('Expected a regular workspace file', 'FS_NOT_REGULAR_FILE');
          if (operation.maxBytes !== undefined && info.size > operation.maxBytes) throw new FsError('Read exceeds the byte limit', 'FS_TOO_LARGE');
          const bytes = new Uint8Array(Math.min(operation.length, Math.max(0, info.size - operation.offset)));
          if (!bytes.length) return bytes;
          const fs = this.computer.provider();
          const fd = fs.openSync(path, 'r');
          let read = 0;
          try {
            while (read < bytes.length) {
              const count = fs.readSync(fd, bytes, read, bytes.length - read, operation.offset + read);
              if (!count) break;
              read += count;
            }
          } finally { fs.closeSync(fd); }
          return bytes.subarray(0, read);
        }
        if (operation.type === 'search') return this.search(path, operation.query, operation.limit);
        const info = this.metadata(path);
        if (operation.type === 'write') {
          if (operation.expected?.kind === 'createIfAbsent' && info) throw new FsError('Read the existing file before replacing it', 'FS_NOT_OBSERVED');
          if (operation.expected?.kind === 'replaceIfVersion' && info?.version !== operation.expected.version) throw new FsError('Workspace file changed since it was read', 'FS_STALE_VERSION');
          const before = info ? this.read(path).content.replaceAll('\r\n', '\n') : null;
          return this.write(path, operation.content.replaceAll('\r\n', '\n'), before);
        }
        if (operation.expectedVersion !== undefined && info?.version !== operation.expectedVersion) throw new FsError('Workspace file changed since it was read', 'FS_STALE_VERSION');
        const before = this.read(path).content.replaceAll('\r\n', '\n');
        const oldString = operation.oldString.replaceAll('\r\n', '\n');
        if (!oldString) throw new FsError('Edit search text cannot be empty', 'FS_EDIT_NOT_FOUND');
        const parts = before.split(oldString);
        if (parts.length === 1) throw new FsError('Edit search text was not found', 'FS_EDIT_NOT_FOUND');
        if (parts.length > 2 && !operation.replaceAll) throw new FsError('Edit matches more than once', 'FS_AMBIGUOUS_EDIT');
        return this.write(path, parts.join(operation.newString.replaceAll('\r\n', '\n')), before);
      });
    } catch (error) {
      if (error instanceof FsError) throw error;
      const code = this.code(error);
      if (code === 'ENOTDIR') throw new FsError('Expected a workspace directory', 'FS_NOT_DIRECTORY');
      if (code === 'ENOENT') throw new FsError('Workspace entry not found', 'FS_NOT_FOUND');
      throw new FsError('Workspace filesystem operation failed', 'FS_IO_ERROR');
    }
  }
  private search(root: string, query: string, limit: number): SearchResult {
    const matches: SearchResult['matches'] = [];
    const pending = [root];
    let entries = 0, bytes = 0;
    while (pending.length) {
      const path = this.guardedPath(pending.pop()!);
      if (path === ATTACHMENT_PRIVATE_ROOT && path !== root) continue;
      const info = this.metadata(path);
      if (!info) throw new FsError('Workspace search path not found', 'FS_NOT_FOUND');
      if (++entries > 1000) return { matches, truncated: true };
      if (info.type === 'directory') {
        const names = this.computer.provider().readdirSync(path) as string[];
        if (names.length + entries > 1000) return { matches, truncated: true };
        pending.push(...names.sort().reverse().map(name => posix.join(path, name)));
      } else {
        bytes += info.size;
        if (bytes > 4 * 1024 * 1024) return { matches, truncated: true };
        const lines = this.read(path).content.split('\n');
        for (let index = 0; index < lines.length; index++) if (lines[index]!.includes(query)) {
          if (matches.length === limit) return { matches, truncated: true };
          matches.push({ path, line: index + 1, text: lines[index]!.slice(0, 2000) });
        }
      }
    }
    return { matches, truncated: false };
  }
}
