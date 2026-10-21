import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/**
 * The official change recorder snapshots the workspace with git and keeps its
 * scratch index, object store and file captures in a temporary directory it
 * reaches through `node:fs`. In Weft git runs in the workspace container, so
 * the recorder's filesystem is that container's too: its `node:fs/promises`
 * and `node:os` resolve to `packages/workspace/src/container-fs.ts`, and each
 * listener and service call runs with its Session's container in scope.
 * Everything else is the official code.
 */
const CONTAINER_FS = resolve('packages/workspace/src/container-fs.ts');
const RECORDER = /packages\/deliverables\/workspace-changes\/src\/[^/]+\.ts$/;

function patch(path, replacements) {
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Upstream change recorder seam changed in ${path}: ${before.slice(0, 60)}`);
    source = source.replaceAll(before, after);
  }
  return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
}

export const nativeChangesPlatform = {
  name: 'harness-native-changes-platform',
  setup(builder) {
    // Weft's typecheck does not follow the deliverables package's Host-controller types; the build bundles it directly.
    builder.onResolve({filter: /^weft:official-deliverables$/}, ({resolveDir}) => builder.resolve('@deepseek-ai/dsh-client-ui-deliverables', {kind: 'import-statement', resolveDir}));
    builder.onResolve({filter: /^node:(fs\/promises|os)$/}, ({importer}) => RECORDER.test(importer) ? {path: CONTAINER_FS} : undefined);
    builder.onLoad({filter: /packages\/deliverables\/workspace-changes\/src\/index\.ts$/}, ({path}) => patch(path, [
      ["import { GitRunner } from './git.ts'", `import { GitRunner } from './git.ts'\nimport { containerFsScope } from ${JSON.stringify(CONTAINER_FS)}`],
      ['export function apply(ctx: Context, config: Config): void {', 'export function apply(ctx: Context, config: Config): void {\n  const inContainer = containerFsScope(ctx)\n  const on = ((name: any, listener: any, options?: any) => ctx.on(name, (...args: any[]) => inContainer(() => listener(...args)), options)) as typeof ctx.on'],
      ['  ctx.effect(() => async () => {\n    lifetime.abort()\n    await Promise.all([...recorders.keys()].map(forget))\n  })', '  ctx.effect(() => () => inContainer(async () => {\n    lifetime.abort()\n    await Promise.all([...recorders.keys()].map(forget))\n  }))'],
      ['diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),', 'diff: (sessionId, seq, index, signal) => inContainer(() => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined)),'],
      ['  ctx.on(', '  on('],
    ]));
  },
};
