/**
 * The official change recorder as the Worker build bundles it (with
 * scripts/native-changes-platform.mjs), over a subprocess service that plays
 * the workspace container with this machine's `sh` and git.
 */
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes';
import { CONTAINER_SH, GIT } from '../../packages/workspace/src/container-commands.ts';
export { changes, endTurn, mutate, settle, startTurn } from '@weft/upstream/packages/deliverables/workspace-changes/tests/support.ts';

interface Spawn { argv: string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal; stdio: {stdin: 'ignore' | {data: string}} }

export async function boot() {
  const spawned: string[] = [];
  const ctx = new Context();
  ctx.provide('subprocess', {
    async resolveExecutable(command: string) {
      if (command === 'git') return GIT;
      throw new Error(`${command}: not in the container`);
    },
    spawn(spec: Spawn) {
      const [executable, ...args] = spec.argv;
      spawned.push(executable!);
      if (executable !== CONTAINER_SH && executable !== GIT) throw new Error(`${executable} would not run in the container`);
      const child = spawn(executable === GIT ? 'git' : '/bin/sh', args, {cwd: spec.cwd === '/workspace' ? '/' : spec.cwd, env: {...process.env, ...spec.env}, ...(spec.signal ? {signal: spec.signal} : {})});
      const output = {stdout: [] as Buffer[], stderr: [] as Buffer[]};
      child.stdout.on('data', (chunk: Buffer) => output.stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => output.stderr.push(chunk));
      child.on('error', () => { /* Settled through `close`. */ });
      child.stdin.end(typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined);
      const reader = (chunks: Buffer[]) => ({readFrom: () => ({text: Buffer.concat(chunks).toString('utf8'), lossy: false})});
      return {
        done: new Promise(resolve => child.on('close', (exitCode, signal) => resolve({exitCode, signal}))),
        collected: {stdout: reader(output.stdout), stderr: reader(output.stderr)},
        terminate: () => child.kill(),
      };
    },
  });
  ctx.provide('fs', {
    resolve: async (path: string, options: {cwd?: string}) => ({path: isAbsolute(path) ? path : join(options.cwd ?? '/', path)}),
    processPath: (target: {path: string}) => target.path,
  });
  await ctx.plugin(SessionStore);
  await ctx.plugin(WorkspaceChanges, WorkspaceChanges.Config({} as WorkspaceChanges.Config));
  return {ctx, spawned, session: (id: string, cwd: string) => ctx.sessions.create(SessionId(id), {meta: {cwd}})};
}
