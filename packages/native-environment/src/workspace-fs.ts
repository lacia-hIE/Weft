import {AsyncLocalStorage} from 'node:async_hooks';
import {workspacePath, type WorkspaceOperation, type FileInfo} from '../../workspace/src/protocol.ts';

type Files = (operation: WorkspaceOperation) => Promise<Response>;
const scope = new AsyncLocalStorage<{files: Files; stats: Map<string, Promise<FileInfo>>}>();
export function withWorkspaceFiles<T>(files: Files, operation: () => T): T {return scope.run({files, stats: new Map()}, operation);}
function current() {const value = scope.getStore(); if (!value) throw new Error('Workspace filesystem used outside its environment'); return value;}
function missing(path: string) {return Object.assign(new Error(`ENOENT: ${path}`), {code: 'ENOENT'});}
export async function stat(raw: string) {
  const path = workspacePath(raw), owner = current();
  let pending = owner.stats.get(path);
  if (!pending) {
    pending = (async () => {
      const response = await owner.files({type: 'stat', path});
      const body = await response.json() as {value?: FileInfo | null};
      if (response.status === 404 || response.ok && !body.value) throw missing(path);
      if (!response.ok || !body.value) throw new Error('Workspace path cannot be read');
      return body.value;
    })();
    owner.stats.set(path, pending);
  }
  const value = await pending;
  return {isDirectory: () => value.type === 'directory', isFile: () => value.type === 'file'};
}
/** The underlying VFS rejects symlinks and canonicalizes paths inside /workspace. */
export async function realpath(raw: string): Promise<string> {const path = workspacePath(raw); await stat(path); return path;}
export async function mkdir(raw: string, options?: {recursive?: boolean}): Promise<void> {
  const path = workspacePath(raw), owner = current();
  if (options?.recursive) {
    try {if ((await stat(path)).isDirectory()) return;}
    catch (error) {if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;}
  }
  const response = await owner.files({type: 'mkdir', path});
  if (!response.ok) throw new Error('Workspace directory creation failed');
  owner.stats.delete(path);
}
