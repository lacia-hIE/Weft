import { posix } from 'node:path';
import type { WorkspaceAttributes, WorkspaceObserver, WorkspaceSpan } from '@cloudflare/computer';
import { ROOT } from './protocol.ts';
import { ATTACHMENT_PRIVATE_ROOT } from '../../native-attachments/src/protocol.ts';

/** Directories a shell may write outside the workspace volume. */
const SCRATCH_ROOTS = ['/tmp'];
const MUTATIONS = new Set(['workspace.fs.writeFile', 'workspace.fs.mkdir', 'workspace.fs.rm', 'workspace.fs.rename', 'workspace.fs.chmod', 'workspace.fs.symlink']);

export interface ShellChange { path: string; removed: boolean }

/** The file-effect mode of one shell execution, as the sandbox policy resolved it. */
export type ShellSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export interface ShellSandbox { mode: ShellSandboxMode; root: string }

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + '/');
function denied(message: string): Error {
  return Object.assign(new Error(message), {code: 'EACCES'});
}

/**
 * The capability boundary for Computer shell executions, enforced on every
 * filesystem operation the shell's Workspace stub performs: attachment storage
 * stays private, writes stay inside the workspace volume (plus scratch space),
 * symlinks are refused like everywhere else in Weft, and each successful
 * mutation is reported so file versions and change feeds stay authoritative.
 */
export function shellPolicy(changed: (changes: ShellChange[]) => void, active: () => readonly ShellSandbox[]): WorkspaceObserver {
  return {
    span(name, attributes, run) {
      if (!name.startsWith('workspace.fs.')) return run(noopSpan);
      const paths = pathsOf(name, attributes);
      const refusal = refuse(name, paths, active());
      if (refusal) return Promise.reject(refusal);
      return run(noopSpan).then(result => {
        if (MUTATIONS.has(name)) {
          const removed = name === 'workspace.fs.rm' || name === 'workspace.fs.rename';
          changed(paths.filter(path => inside(path, ROOT)).map((path, index) => ({path, removed: removed && index === 0})));
        }
        return result;
      });
    },
  };
}

/**
 * Concurrent executions of one workspace share its filesystem calls, so a
 * mutation must satisfy every running execution's mode: overlap can only
 * refuse more, never grant more.
 */
function refuse(name: string, paths: readonly string[], sandboxes: readonly ShellSandbox[]): Error | undefined {
  for (const path of paths) if (inside(path, ATTACHMENT_PRIVATE_ROOT)) return denied(`${path}: Weft attachment storage is not accessible from the shell`);
  if (!MUTATIONS.has(name)) return undefined;
  if (name === 'workspace.fs.symlink') return denied('Workspace symlinks are not supported');
  for (const sandbox of sandboxes.length ? sandboxes : [{mode: 'workspace-write' as const, root: ROOT}]) {
    if (sandbox.mode === 'read-only') return denied(`${paths[0]}: blocked by the read-only sandbox`);
    if (sandbox.mode === 'workspace-write') {
      for (const path of paths) if (!inside(path, sandbox.root) && !SCRATCH_ROOTS.some(root => inside(path, root))) return denied(`${path}: blocked by the workspace-write sandbox (writable: ${sandbox.root}, ${SCRATCH_ROOTS.join(', ')})`);
    }
  }
  return undefined;
}

function pathsOf(name: string, attributes: WorkspaceAttributes): string[] {
  const paths: string[] = [];
  for (const key of ['workspace.fs.path', 'workspace.fs.destination']) {
    const value = attributes[key];
    if (typeof value === 'string') paths.push(posix.resolve('/', value));
  }
  if (name === 'workspace.fs.rename' && paths.length === 2) return paths;
  return paths.slice(0, 1);
}

const noopSpan: WorkspaceSpan = {setAttribute() {}};
