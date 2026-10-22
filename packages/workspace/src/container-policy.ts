/** Rebuildable container files: never sync these trees into the durable workspace. */
export const CONTAINER_LOCAL_PATHS = [
  '**/node_modules', '**/.venv', '**/__pycache__', '**/.pytest_cache',
  '**/.mypy_cache', '**/.ruff_cache', '**/.next/cache', '**/.turbo',
] as const;

/** Preserve the private attachment boundary alongside the local dependency/cache trees. */
export const CONTAINER_MOUNT_IGNORE = ['/.weft', ...CONTAINER_LOCAL_PATHS].join(',');

/** Operational context for all presets and execution modes, not only the auto-mode switch tool. */
export function workspaceRuntimeGuide(shell: 'worker' | 'container' | 'auto', container: boolean): string {
  return `Workspace runtime: ${shell}; shell commands currently use the ${container ? 'container' : 'Worker'}.
The Worker shell has no git, node, npm or python. ${shell === 'worker' ? 'This environment forbids the container.' : shell === 'auto' ? 'Use workspace_runtime to switch to the container before running those programs.' : 'The container provides git, Node 22, npm, Python 3 and ripgrep.'}
Source files and .git under /workspace persist and are shared with the file tools. In the container, these paths are local-only: ${CONTAINER_LOCAL_PATHS.join(', ')}. They are invisible to Worker/file tools and lost when the container is replaced after idle shutdown. Run dependency inspection, installation, builds and tests in the container; recreate missing dependencies from lockfiles. Keep source, user changes and deliverables out of local-only directories. .gitignore does not control workspace synchronization.
Synced /workspace files have a computerd FUSE limit of 256 MiB per file. For tasks that do not need full history, prefer git clone --depth 1 --single-branch --no-tags. For a large monorepo, consider --filter=blob:none --sparse and git sparse-checkout set for the needed directories when the remote supports it. These reduce size but do not guarantee a pack below the limit. If full history is needed, preserve it; do not silently replace it with a shallow clone. pack.packSizeLimit does not limit an incoming clone pack. Do not move .git outside /workspace or discard unpushed commits without an explicit recovery plan.
The container sleeps after 10 idle minutes. Paths outside /workspace are temporary; a larger container does not remove the per-file limit. Container commands and terminals use real Linux processes/PTYs. Read-only and workspace-write policies are enforced inside the container; enforcement may be partial on older kernels. Processes and terminal state end on container restart; commands are never automatically replayed.`;
}

/** Diagnose an actual failed container write without changing its exit code or retrying the command. */
export function containerFailureHint(stderr: string, code: unknown): string | undefined {
  if (typeof code !== 'number' || code === 0 || !/\bEFBIG\b|\bFile too large\b/i.test(stderr)) return;
  return '[Weft workspace] computerd limits synced /workspace files to 256 MiB each. A Git pack can exceed this limit even when the repository contains only small source files. If full history is unnecessary, retry in a new directory with git clone --depth 1 --single-branch --no-tags; consider partial/sparse clone for large trees. These options cannot guarantee a small enough pack. Increasing container size or setting pack.packSizeLimit does not remove this limit. Preserve existing files and unpushed commits; putting .git on container-local disk loses it when the container is replaced.\n';
}
