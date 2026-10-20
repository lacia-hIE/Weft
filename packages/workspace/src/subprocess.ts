import type { Context } from '@deepseek-ai/cordis';
import { PassThrough, type Readable } from 'node:stream';
import { posix } from 'node:path';
import SubprocessRuntime, { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import type { ShellExecSpec, ShellExecRequest as BashRequest, ShellExecution } from '@deepseek-ai/dsh-shell';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellSandbox, ShellSandboxMode } from './shell.ts';
import type { SubprocessCollect, SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec, SubprocessTerminalActivity, SubprocessTerminalEnvironment, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';

/** One shell execution request for the environment's Computer runtime. */
export interface ShellExecRequest { id: string; command: string; cwd: string; env?: Record<string, string>; stdin?: string; sandbox?: ShellSandbox }
export interface ShellTransport {
  exec(request: ShellExecRequest): Promise<Response>;
  kill(id: string): Promise<void>;
}

const SHELLS = new Set(['bash', 'sh']);

/** Bounded tail retention with absolute byte offsets, as the collect disposition specifies. */
class TailCollector implements SubprocessOutputReader {
  private chunks: Uint8Array[] = [];
  private retained = 0;
  private total = 0;
  constructor(private readonly maxBytes: number) {}
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.retained += bytes.byteLength;
    this.total += bytes.byteLength;
    while (this.retained > this.maxBytes && this.chunks.length) {
      const first = this.chunks[0]!;
      const excess = this.retained - this.maxBytes;
      if (first.byteLength <= excess) {this.chunks.shift(); this.retained -= first.byteLength;}
      else {this.chunks[0] = first.subarray(excess); this.retained -= excess;}
    }
  }
  readFrom(fromByte: number) {
    const start = this.total - this.retained;
    const lossy = fromByte < start;
    const skip = Math.max(0, Math.min(fromByte, this.total) - start);
    const bytes = new Uint8Array(this.retained);
    let offset = 0;
    for (const chunk of this.chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    return {text: new TextDecoder().decode(bytes.subarray(skip)), nextOffset: this.total, lossy};
  }
}

/**
 * The subprocess seam over the environment's Computer shell: `bash -c` and
 * `sh -c` commands run in just-bash inside the workspace's Dynamic Worker,
 * against the same volume as every Weft file tool. Other executables do not
 * exist in this world, and interactive terminals are not provided.
 */
export class WorkspaceSubprocess extends SubprocessRuntime {
  constructor(ctx: Context, private readonly transport: ShellTransport) { super(ctx); }

  override async resolveExecutable(command: string): Promise<string> {
    const name = posix.basename(command);
    if (SHELLS.has(name) && (command === name || command === `/bin/${name}` || command === `/usr/bin/${name}`)) return `/bin/${name}`;
    throw new SubprocessExecutableNotFoundError(`${command}: only bash and sh exist in this workerd environment`);
  }

  override async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return {platform: 'posix', defaultShell: '/bin/bash'};
  }

  /**
   * A line-mode terminal over the same shell: input is echoed and edited
   * locally, each submitted line runs as one command, and the working
   * directory carries over between lines. Full-screen and interactive
   * programs are not available.
   */
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    spec.signal?.throwIfAborted();
    const [executable] = spec.argv;
    if (executable === undefined || !SHELLS.has(posix.basename(executable))) throw new SubprocessExecutableNotFoundError(`${executable ?? ''}: only bash and sh exist in this workerd environment`);
    return new LineTerminal(this.transport, spec.cwd, spec.env ?? {});
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted();
    const [executable, flag, command] = spec.argv;
    if (executable === undefined || !SHELLS.has(posix.basename(executable)) || flag !== '-c' || typeof command !== 'string' || spec.argv.length > 3) {
      throw new SubprocessExecutableNotFoundError(`${spec.argv.join(' ')}: only \`bash -c\` and \`sh -c\` run in this workerd environment`);
    }
    if (spec.stdio.stdin === 'pipe') throw new Error('Interactive stdin is not available in this workerd environment');
    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    const outputs = {stdout: output(spec.stdio.stdout), stderr: output(spec.stdio.stderr)};
    let killed = false;
    const terminate = () => {
      if (killed) return;
      killed = true;
      void this.transport.kill(id).catch(() => { /* The execution already settled. */ });
    };
    spec.signal?.addEventListener('abort', terminate, {once: true});
    const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].startsWith('WEFT_SANDBOX_')));
    const mode = spec.env?.WEFT_SANDBOX_MODE as ShellSandboxMode | undefined;
    const sandbox: ShellSandbox | undefined = mode ? {mode, root: spec.env?.WEFT_SANDBOX_ROOT ?? '/workspace'} : undefined;
    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        const response = await this.transport.exec({id, command, cwd: spec.cwd, env, ...(sandbox ? {sandbox} : {}), ...(typeof spec.stdio.stdin === 'object' ? {stdin: spec.stdio.stdin.data} : {})});
        if (!response.ok || !response.body) {
          const failure = await response.json().catch(() => ({error: `HTTP ${response.status}`})) as {error?: string};
          throw new Error(`Shell execution failed to start: ${failure.error ?? response.status}`);
        }
        let exitCode: number | null = null;
        let pending = '';
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        const frame = (line: string) => {
          const value = JSON.parse(line) as {type: string; data?: string; code?: number};
          if (value.type === 'exit') exitCode = typeof value.code === 'number' ? value.code : null;
          else if (value.type === 'stdout' || value.type === 'stderr') outputs[value.type].write(encoder.encode(value.data ?? ''));
        };
        for (;;) {
          const {done: finished, value} = await reader.read();
          if (finished) break;
          pending += decoder.decode(value, {stream: true});
          for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (line) frame(line);
          }
        }
        if (pending.trim()) frame(pending);
        return killed && exitCode === null ? {exitCode: null, signal: 'SIGKILL'} : {exitCode, signal: null};
      } finally {
        spec.signal?.removeEventListener('abort', terminate);
        outputs.stdout.end();
        outputs.stderr.end();
      }
    })();
    return {
      stdin: undefined,
      stdout: outputs.stdout.readable,
      stderr: outputs.stderr.readable,
      control: undefined,
      collected: {
        ...(outputs.stdout.collector ? {stdout: outputs.stdout.collector} : {}),
        ...(outputs.stderr.collector ? {stderr: outputs.stderr.collector} : {}),
      },
      done,
      terminate,
      async waitForExit(signal?: AbortSignal): Promise<boolean> {
        if (!signal) {await done.catch(() => undefined); return true;}
        return await Promise.race([done.then(() => true, () => true), new Promise<boolean>(resolve => {
          if (signal.aborted) resolve(false);
          signal.addEventListener('abort', () => resolve(false), {once: true});
        })]);
      },
    };
  }
}

/** One stdout/stderr disposition: a raw pipe, a bounded collector, or nothing. */
function output(mode: 'pipe' | 'inherit' | SubprocessCollect) {
  const pipe = mode === 'pipe' ? new PassThrough() : undefined;
  const collector = typeof mode === 'object' ? new TailCollector(mode.maxBytes) : undefined;
  return {
    readable: pipe as Readable | undefined,
    collector,
    write(bytes: Uint8Array) { pipe?.write(bytes); collector?.push(bytes); },
    end() { pipe?.end(); },
  };
}

/**
 * The bash executor over the Computer shell, confining like the original
 * sandbox executor: every execution carries its resolved sandbox policy and
 * the workspace's filesystem boundary enforces its mode.
 */
export class ComputerBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandboxPolicy'];
  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode; }
  override resolve(request: BashRequest): ShellExecSpec {
    return {...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()};
  }
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy;
    const execution = await super.execute({...spec, env: {...spec.env, WEFT_SANDBOX_MODE: policy.mode, WEFT_SANDBOX_ROOT: policy.workspaceRoot}});
    const base = execution.result.bind(execution);
    let decorated: ReturnType<ShellExecution['result']> | undefined;
    execution.result = () => decorated ??= base().then(result => ({...result, sandbox: {mode: policy.mode, denied: /blocked by the (read-only|workspace-write) sandbox/.test(result.stderr.text), enforcement: 'full'}}));
    return execution;
  }
}

/** The base bundle's execution rows over the Computer shell: subprocess, shell environment, bash executor and job registry. */
export async function mountWorkspaceShell(ctx: Context, transport: ShellTransport, cwd: string): Promise<void> {
  await ctx.plugin(WorkspaceSubprocess, transport);
  await ctx.plugin(ShellEnv, {});
  await ctx.plugin(SandboxPolicy, {workspaceRoot: '/workspace', mode: 'workspace-write'});
  await ctx.plugin(ComputerBashExecutor, {cwd});
  await ctx.plugin(LocalJobRegistry, {});
}

let terminalIds = 1000;
const CWD_MARK = '\u001eweft-cwd:';

/** One line-mode terminal session; see {@link WorkspaceSubprocess.spawnTerminal}. */
class LineTerminal implements SubprocessTerminalHandle {
  readonly pid = ++terminalIds;
  readonly output = new PassThrough();
  readonly done: Promise<SubprocessOutcome>;
  private settle!: (outcome: SubprocessOutcome) => void;
  private line = '';
  private escape = '';
  private running: string | undefined;
  private revision = 0;
  private closed = false;

  constructor(private readonly transport: ShellTransport, private cwd: string, private readonly env: Record<string, string>) {
    this.done = new Promise(resolve => {this.settle = resolve;});
    this.prompt();
  }

  private emit(text: string): void { if (!this.closed) this.output.write(new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'))); }
  private prompt(): void { this.emit(`\u001b[1;32mweft\u001b[0m:\u001b[1;34m${this.cwd.replace(/^\/workspace(?=\/|$)/, '~')}\u001b[0m$ `); }

  async write(data: string): Promise<void> {
    for (const char of data) {
      if (this.escape) {
        this.escape += char;
        // CSI and SS3 sequences (cursor keys, function keys) end with a final byte; history and line motion are not provided.
        if (this.escape.length > 2 && /[@-~]/.test(char) || this.escape.length > 16) this.escape = '';
        continue;
      }
      if (char === '\u001b') {this.escape = char; continue;}
      if (char === '\u0003') {
        if (this.running) await this.signalForeground('SIGINT');
        else {this.line = ''; this.emit('^C\n'); this.prompt();}
        continue;
      }
      if (this.running) continue;
      if (char === '\u0004') {if (!this.line) {this.emit('exit\n'); await this.finish({exitCode: 0, signal: null});} continue;}
      if (char === '\r' || char === '\n') {this.emit('\n'); const line = this.line; this.line = ''; void this.run(line); continue;}
      if (char === '\u007f' || char === '\b') {if (this.line) {this.line = [...this.line].slice(0, -1).join(''); this.emit('\b \b');} continue;}
      if (char >= ' ') {this.line += char; this.emit(char);}
    }
  }

  private async run(line: string): Promise<void> {
    const command = line.trim();
    if (!command) {this.prompt(); return;}
    if (command === 'exit') {await this.finish({exitCode: 0, signal: null}); return;}
    if (command === 'clear') {this.emit('\u001b[2J\u001b[H'); this.prompt(); return;}
    const id = crypto.randomUUID();
    this.running = id;
    this.revision++;
    let held = '';
    try {
      // The user's own terminal is not confined to a sandbox mode; Weft's storage boundary still applies.
      const response = await this.transport.exec({id, command: `${line}\nprintf '${CWD_MARK.replace('\u001e', '\\036')}%s\\036' "$PWD"`, cwd: this.cwd, env: this.env, sandbox: {mode: 'danger-full-access', root: '/workspace'}});
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        pending += decoder.decode(value, {stream: true});
        for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
          const frame = JSON.parse(pending.slice(0, index)) as {type: string; data?: string};
          pending = pending.slice(index + 1);
          if (frame.type === 'stderr') this.emit(frame.data ?? '');
          if (frame.type === 'stdout') {
            // Hold back everything from the record separator on: the trailing cwd report.
            held += frame.data ?? '';
            const mark = held.indexOf('\u001e');
            if (mark < 0) {this.emit(held); held = '';}
            else {this.emit(held.slice(0, mark)); held = held.slice(mark);}
          }
        }
      }
      const report = held.match(/^\u001eweft-cwd:([^\u001e]*)\u001e/);
      if (report?.[1]?.startsWith('/')) this.cwd = report[1];
      else this.emit(held);
    } catch (error) {
      this.emit(`weft: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (this.running === id) {this.running = undefined; this.revision++;}
      if (!this.closed) this.prompt();
    }
  }

  async resize(): Promise<void> {}
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.running ? {processGroupId: this.pid, inputWaiting: false} : undefined;
  }
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    return {state: this.running ? 'busy' : 'idle', revision: this.revision};
  }
  async signalForeground(_signal: SubprocessTerminalSignal): Promise<number> {
    const id = this.running;
    if (!id) return 0;
    await this.transport.kill(id).catch(() => { /* The command already settled. */ });
    this.emit('^C\n');
    return 1;
  }
  async terminate(): Promise<void> {
    if (this.running) await this.transport.kill(this.running).catch(() => { /* The command already settled. */ });
    await this.finish({exitCode: null, signal: 'SIGTERM'});
  }
  private async finish(outcome: SubprocessOutcome): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.output.end();
    this.settle(outcome);
  }
}
