import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-subprocess';
import { CONTAINER_SH, shellWord } from './container-commands.ts';

/**
 * The `node:fs/promises` and `node:os` subset the official change recorder
 * uses, served by the workspace container. The recorder hands the paths it
 * creates to git, which runs in the container, so its scratch files, its
 * captures and the workspace it reads must all be the container's: each call
 * here runs one command there. Calls resolve the container through the
 * Session whose listener is running (see `scripts/native-changes-platform.mjs`).
 */

/** Runs one script in a Session's workspace container. */
interface ContainerScripts {
  run(script: string, options?: {stdin?: string; signal?: AbortSignal | undefined}): Promise<{code: number | null; stdout: string; stderr: string}>;
}

const scope = new AsyncLocalStorage<ContainerScripts>();

/** Bytes of command output one call keeps; a capture is at most the recorder's file cap, base64-encoded. */
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Exit codes the scripts use for the errors the recorder distinguishes. */
const MISSING = 2, EXISTS = 3;

/**
 * A function that runs its callback with this Session's container as the
 * filesystem; asynchronous work started inside keeps it.
 */
export function containerFsScope(ctx: Context): <T>(callback: () => T) => T {
  const scripts: ContainerScripts = {
    async run(script, options = {}) {
      const handle = ctx.subprocess.spawn({
        argv: [CONTAINER_SH, '-c', script], cwd: '/workspace', graceMs: 1_000,
        stdio: {stdin: options.stdin === undefined ? 'ignore' : {data: options.stdin}, stdout: {maxBytes: OUTPUT_MAX_BYTES}, stderr: {maxBytes: 16 * 1024}},
        ...(options.signal ? {signal: options.signal} : {}),
      });
      const outcome = await handle.done;
      options.signal?.throwIfAborted();
      return {code: outcome.exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? ''};
    },
  };
  return callback => scope.run(scripts, callback);
}

function scripts(): ContainerScripts {
  const current = scope.getStore();
  if (!current) throw new Error('Workspace container filesystem used outside a Session listener');
  return current;
}

class ContainerFsError extends Error {
  constructor(readonly code: string, operation: string, path: string, detail = '') {
    super(`${code}: ${operation} '${path}'${detail ? `: ${detail.trim()}` : ''}`);
  }
}

async function run(operation: string, path: string, script: string, options?: {stdin?: string; signal?: AbortSignal | undefined}): Promise<string> {
  const result = await scripts().run(script, options);
  if (result.code === 0) return result.stdout;
  if (result.code === MISSING) throw new ContainerFsError('ENOENT', operation, path);
  if (result.code === EXISTS) throw new ContainerFsError('EEXIST', operation, path);
  throw new ContainerFsError('EIO', operation, path, result.stderr);
}

const q = shellWord;
const exists = (path: string) => `[ -e ${q(path)} ] || [ -L ${q(path)} ] || exit ${MISSING}`;

export async function realpath(path: string): Promise<string> {
  return (await run('realpath', path, `${exists(path)}; realpath -- ${q(path)}`)).replace(/\n$/, '');
}

export async function mkdir(path: string, options?: {recursive?: boolean}): Promise<string | undefined> {
  await run('mkdir', path, options?.recursive ? `mkdir -p -- ${q(path)}` : `[ -e ${q(path)} ] && exit ${EXISTS}; mkdir -- ${q(path)}`);
  return undefined;
}

export async function mkdtemp(prefix: string): Promise<string> {
  return (await run('mkdtemp', prefix, `mktemp -d -- ${q(`${prefix}XXXXXX`)}`)).replace(/\n$/, '');
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await run('copyfile', source, `${exists(source)}; cp -- ${q(source)} ${q(destination)}`);
}

export async function rm(path: string, options?: {recursive?: boolean; force?: boolean}): Promise<void> {
  await run('rm', path, `${options?.force ? '' : `${exists(path)}; `}rm ${options?.recursive ? '-r ' : ''}-f -- ${q(path)}`);
}

type Encoding = 'utf8' | 'utf-8';
export async function readFile(path: string, options: Encoding | {encoding: Encoding; signal?: AbortSignal}): Promise<string>;
export async function readFile(path: string, options?: {signal?: AbortSignal}): Promise<Buffer>;
export async function readFile(path: string, options?: Encoding | {encoding?: Encoding; signal?: AbortSignal}): Promise<string | Buffer> {
  const signal = typeof options === 'object' ? options.signal : undefined;
  const bytes = Buffer.from(await run('open', path, `${exists(path)}; base64 -w0 -- ${q(path)}`, {signal}), 'base64');
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? bytes.toString('utf8') : bytes;
}

export async function writeFile(path: string, data: Uint8Array | string, options?: {flag?: string}): Promise<void> {
  const exclusive = options?.flag === 'wx' ? `[ -e ${q(path)} ] && exit ${EXISTS}; ` : '';
  await run('open', path, `${exclusive}base64 -d > ${q(path)}`, {stdin: Buffer.from(data).toString('base64')});
}

/** A read-only handle; reads fetch the requested byte range from the container. */
class ContainerFileHandle {
  constructor(private readonly path: string, private readonly regular: boolean) {}
  async stat() { return {isFile: () => this.regular}; }
  async read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number; buffer: Uint8Array}> {
    if (length === 0) return {bytesRead: 0, buffer};
    const bytes = Buffer.from(await run('read', this.path, `tail -c +${position + 1} -- ${q(this.path)} | head -c ${length} | base64 -w0`), 'base64');
    buffer.set(bytes, offset);
    return {bytesRead: bytes.length, buffer};
  }
  async close(): Promise<void> { /* Nothing stays open in the container. */ }
}

export async function open(path: string, flags: 'r'): Promise<ContainerFileHandle> {
  if (flags !== 'r') throw new Error('The workspace container filesystem opens files for reading only');
  const kind = await run('open', path, `${exists(path)}; [ -f ${q(path)} ] && echo file || echo other`);
  return new ContainerFileHandle(path, kind.trim() === 'file');
}

/** The container's home and temporary directories. */
export const homedir = () => '/root';
export const tmpdir = () => '/tmp';
