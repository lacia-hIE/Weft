import type { Context } from '@deepseek-ai/cordis';
import { PassThrough, type Readable } from 'node:stream';
import { posix } from 'node:path';
import SubprocessRuntime, { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { SandboxProvider, type ConfinedArgv, type SandboxPolicy as ConfinedPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecSpec, ShellExecRequest as BashRequest, ShellExecution } from '@deepseek-ai/dsh-shell';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellSandbox, ShellSandboxMode } from './shell.ts';
import type { SubprocessCollect, SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec, SubprocessTerminalActivity, SubprocessTerminalEnvironment, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';

/** One shell execution request for the environment's Computer runtime; `container` requires the workspace container. */
export interface ShellExecRequest { id: string; command: string; cwd: string; env?: Record<string, string>; stdin?: string; sandbox?: ShellSandbox; container?: true }
export interface ShellTransport {
  exec(request: ShellExecRequest): Promise<Response>;
  kill(id: string): Promise<void>;
}

const SHELLS = new Set(['bash', 'sh']);
import { CONTAINER_SH, GIT, RIPGREP, shellWord } from './container-commands.ts';
import { SPILL_ROOT, storeText } from './spill.ts';
export { RIPGREP };
/** One argv element as a POSIX shell word. */

/** The argv prefix {@link WorkspaceSandbox.confine} adds; the subprocess seam turns it back into a shell sandbox. */
const SANDBOX_RUNNER = '/weft/sandbox';

/** A confined argv's sandbox and the caller's own argv; argv without the runner prefix is returned as is. */
function unconfine(argv: readonly string[]): {argv: readonly string[]; sandbox?: ShellSandbox} {
  if (argv[0] !== SANDBOX_RUNNER) return {argv};
  const [, mode, root, separator, ...rest] = argv;
  if ((mode !== 'read-only' && mode !== 'workspace-write') || !root || separator !== '--') throw new Error('Malformed workspace sandbox argv');
  return {argv: rest, sandbox: {mode, root}};
}

/**
 * The sandbox provider of the Computer shell. Its executions have no host to
 * escape: every file effect goes through the workspace's file observer, which
 * enforces the mode. Confinement therefore only records the policy in argv
 * for the subprocess seam to hand to the Workspace.
 */
export class WorkspaceSandbox extends SandboxProvider {
  async confine(argv: readonly string[], policy: ConfinedPolicy): Promise<ConfinedArgv> {
    return {
      argv: [SANDBOX_RUNNER, policy.mode, policy.workspaceRoot, '--', ...argv],
      enforcement: 'full',
      denialSignatures: ['blocked by the read-only sandbox', 'blocked by the workspace-write sandbox'],
      runnerFailureRules: [],
    };
  }
}

/** Bytes of one stream kept for its full-output file, whatever larger spill cap a caller asks for: the stream is held in the Session's memory until the command ends. */
const FULL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bounded tail retention with absolute byte offsets, as the collect
 * disposition specifies. With a spill cap the whole stream is also kept, up to
 * that cap, so a truncated stream can be saved in full when the command ends.
 */
class TailCollector implements SubprocessOutputReader {
  private chunks: Uint8Array[] = [];
  private retained = 0;
  private total = 0;
  private full: Uint8Array[] | undefined;
  /** The workspace file holding the complete stream, once saved. */
  spillPath: string | undefined;
  constructor(private readonly maxBytes: number, private readonly spillMaxBytes?: number) {
    if (spillMaxBytes !== undefined) this.full = [];
  }
  /** The complete stream when it was truncated and kept whole, else undefined. */
  fullText(): string | undefined {
    if (!this.full || this.total === this.retained) return undefined;
    const bytes = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.full) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    return new TextDecoder().decode(bytes);
  }
  push(bytes: Uint8Array): void {
    // A stream beyond the spill cap keeps only its tail, as an incomplete spill file is discarded.
    if (this.full && this.total + bytes.byteLength <= this.spillMaxBytes!) this.full.push(bytes);
    else this.full = undefined;
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
    return {text: new TextDecoder().decode(bytes.subarray(skip)), nextOffset: this.total, lossy, ...(this.spillPath ? {spillPath: this.spillPath} : {})};
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

  /** Save each truncated stream that asked for a spill file into the workspace, where the model reads it with the file tools. */
  private async saveFullOutput(id: string, outputs: Record<'stdout' | 'stderr', {collector: TailCollector | undefined}>): Promise<void> {
    const fs = this.ctx.get('fs');
    if (!fs) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      const collector = outputs[stream].collector;
      const text = collector?.fullText();
      if (!collector || text === undefined) continue;
      try {
        collector.spillPath = (await storeText(fs, `${SPILL_ROOT}/output/${id}-${stream}.txt`, `${SPILL_ROOT}/output/${id}-${stream}`, text)).path;
      } catch (error) {
        // The tail stays available; the tool then reports the full output as unavailable.
        this.ctx.logger.warn(`full ${stream} of a command could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  override async resolveExecutable(command: string): Promise<string> {
    const name = posix.basename(command);
    if (command === RIPGREP || command === 'rg') return RIPGREP;
    if (command === GIT || command === 'git') return GIT;
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
    const {argv, sandbox} = unconfine(spec.argv);
    const [executable] = argv;
    if (executable === undefined || !SHELLS.has(posix.basename(executable))) throw new SubprocessExecutableNotFoundError(`${executable ?? ''}: only bash and sh exist in this workerd environment`);
    return new LineTerminal(this.transport, spec.cwd, spec.env ?? {}, sandbox);
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted();
    const {argv, sandbox: confined} = unconfine(spec.argv);
    const [executable, flag, script] = argv;
    // ripgrep and git exist in the workspace container; their argv becomes one quoted command there.
    const direct = executable === RIPGREP || executable === GIT;
    const shell = executable === CONTAINER_SH || (executable !== undefined && SHELLS.has(posix.basename(executable)));
    if (!direct && (!shell || flag !== '-c' || typeof script !== 'string' || argv.length > 3)) {
      throw new SubprocessExecutableNotFoundError(`${argv.join(' ')}: only \`bash -c\`, \`sh -c\`, ripgrep and git run in this workerd environment`);
    }
    const container = direct || executable === CONTAINER_SH;
    const command = direct ? argv.map(shellWord).join(' ') : script!;
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
    const sandbox: ShellSandbox | undefined = confined ?? (mode ? {mode, root: spec.env?.WEFT_SANDBOX_ROOT ?? '/workspace'} : undefined);
    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        const response = await this.transport.exec({id, command, cwd: spec.cwd, env, ...(sandbox ? {sandbox} : {}), ...(container ? {container: true as const} : {}), ...(typeof spec.stdio.stdin === 'object' ? {stdin: spec.stdio.stdin.data} : {})});
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
        await this.saveFullOutput(id, outputs);
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
  const collector = typeof mode === 'object' ? new TailCollector(mode.maxBytes, mode.spill ? Math.min(mode.spill.maxBytes, FULL_OUTPUT_MAX_BYTES) : undefined) : undefined;
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
  await ctx.plugin(WorkspaceSandbox);
  await ctx.plugin(ComputerBashExecutor, {cwd});
  await ctx.plugin(LocalJobRegistry, {});
}

let terminalIds = 1000;
const STATE_MARK = '\u001eweft-state\u001e';
/** Shell variables a fresh shell owns; replaying them would be wrong or rejected. */
const SHELL_OWNED = new Set(['BASHOPTS', 'SHELLOPTS', 'PWD', 'BASHPID', 'PPID', 'RANDOM', 'SECONDS', 'LINENO', 'UID', 'EUID', '_']);

/**
 * Report the shell state after a command: variables (`declare -p`), aliases,
 * function definitions and the working directory, between record separators,
 * then run `PROMPT_COMMAND` with the command's exit status as bash does
 * before each prompt.
 */
const STATE_REPORT = `__weft_status=$?
printf '\\036weft-state\\036'; declare -p; printf '\\036'; alias; printf '\\036'
for __weft_f in $(compgen -A function); do type "$__weft_f" | tail -n +2; done
printf '\\036%s\\036' "$PWD"
(exit $__weft_status); eval "\${PROMPT_COMMAND:-}"`;

/**
 * Function definitions in submitted shell source, by name. Computer's
 * just-bash prints function bodies through `type` without their parameter
 * expansions, so the terminal keeps each definition's own source.
 */
function functionDefinitions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const header = /(?:^|[\s;&|(])(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    const name = (match[1] ?? match[2])!;
    let depth = 0;
    let quote: string | undefined;
    let end = -1;
    for (let index = match.index + match[0].length - 1; index < source.length; index++) {
      const char = source[index]!;
      if (char === '\\' && quote !== "'") {index++; continue;}
      if (quote) {if (char === quote) quote = undefined; continue;}
      if (char === "'" || char === '"') {quote = char; continue;}
      if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {end = index; break;}
    }
    if (end < 0) break;
    found.set(name, `${name} () ${source.slice(match.index + match[0].length - 1, end + 1)}`);
    header.lastIndex = end + 1;
  }
  return found;
}

/** `type` output for every defined function, split into definitions by name. */
function reportedFunctions(report: string): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of report.split('\n')) {
    const header = /^([A-Za-z_][\w-]*) \(\) ?$/.exec(line);
    if (header) {name = header[1]!; found.set(name, line); continue;}
    if (name !== undefined) found.set(name, found.get(name) + '\n' + line);
  }
  return found;
}

/** The replay script for a reported state: the next command starts where the last one ended. */
function restoreScript(report: string, sources: Map<string, string>): string {
  const [variables = '', aliases = '', functions = ''] = report.split('\u001e');
  // A value with newlines continues its declaration on the following lines.
  const lines: string[] = [];
  for (const line of variables.split('\n')) {
    if (line.startsWith('declare ') || lines.length === 0) lines.push(line);
    else lines[lines.length - 1] += '\n' + line;
  }
  const declarations = lines.filter(line => {
    const name = /^declare -[-a-zA-Z]* ([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
    return name !== undefined && !SHELL_OWNED.has(name) && !name.startsWith('__weft_');
  });
  // An interactive shell expands aliases; the replayed one runs a script.
  const aliasLines = aliases.trim() ? `shopt -s expand_aliases\n${aliases.trim()}` : '';
  const definitions = [...reportedFunctions(functions)].map(([name, printed]) => sources.get(name) ?? printed);
  return [...declarations, aliasLines, ...definitions].filter(Boolean).join('\n');
}

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
  /** Shell state carried into the next command; each line otherwise runs in a fresh just-bash. */
  private state = '';
  /** The source of each function the shell's commands defined. */
  private readonly functions = new Map<string, string>();

  constructor(private readonly transport: ShellTransport, private cwd: string, private readonly env: Record<string, string>, private readonly sandbox?: ShellSandbox) {
    this.done = new Promise(resolve => {this.settle = resolve;});
    // A shell with PROMPT_COMMAND runs it before its first prompt as well.
    if (env.PROMPT_COMMAND) void this.run('', true);
    else this.prompt();
  }

  private emit(text: string): void { if (!this.closed) this.output.write(new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'))); }
  private prompt(): void {
    if (this.env.PS1 !== undefined) this.emit(this.env.PS1);
    else this.emit(`\u001b[1;32mweft\u001b[0m:\u001b[1;34m${this.cwd.replace(/^\/workspace(?=\/|$)/, '~')}\u001b[0m$ `);
  }

  async write(data: string): Promise<void> {
    const chars = [...data];
    for (const [index, char] of chars.entries()) {
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
      if (char === '\r' || char === '\n') {
        // Newlines inside one write are a pasted multi-line command; the write's last newline submits it.
        if (chars.slice(index + 1).some(next => next !== '\r' && next !== '\n')) {this.line += '\n'; this.emit('\n'); continue;}
        if (char === '\n' && chars[index - 1] === '\r') continue;
        this.emit('\n');
        const line = this.line;
        this.line = '';
        void this.run(line);
        continue;
      }
      if (char === '\u007f' || char === '\b') {if (this.line) {this.line = [...this.line].slice(0, -1).join(''); this.emit('\b \b');} continue;}
      if (char >= ' ' || char === '\t') {this.line += char; this.emit(char);}
    }
  }

  private async run(line: string, startup = false): Promise<void> {
    const command = line.trim();
    if (!startup) {
      if (!command) {this.prompt(); return;}
      if (command === 'exit') {await this.finish({exitCode: 0, signal: null}); return;}
      if (command === 'clear') {this.emit('\u001b[2J\u001b[H'); this.prompt(); return;}
    }
    const id = crypto.randomUUID();
    this.running = id;
    this.revision++;
    let held = '';
    let reported = false;
    let exitCode: number | undefined;
    for (const [name, source] of functionDefinitions(line)) this.functions.set(name, source);
    try {
      // A terminal spawned under a policy is confined by it; the user's own terminal is not, though Weft's storage boundary still applies.
      const response = await this.transport.exec({id, command: `${this.state}\n${startup ? ':' : line}\n${STATE_REPORT}`, cwd: this.cwd, env: this.env, sandbox: this.sandbox ?? {mode: 'danger-full-access', root: '/workspace'}});
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const stdout = (text: string) => {
        if (reported) {this.emit(text); return;}
        // Hold back everything from the state mark on until the report closes.
        held += text;
        const mark = held.indexOf(STATE_MARK);
        if (mark < 0) {
          const keep = held.length - STATE_MARK.length;
          if (keep > 0) {this.emit(held.slice(0, keep)); held = held.slice(keep);}
          return;
        }
        if (mark > 0) {this.emit(held.slice(0, mark)); held = held.slice(mark);}
        const fields = held.slice(STATE_MARK.length).split('\u001e');
        // variables, aliases, functions, cwd, then the text after the report.
        if (fields.length < 5) return;
        const [variables = '', aliases = '', functions = '', cwd = ''] = fields;
        if (cwd.startsWith('/')) this.cwd = cwd;
        this.state = restoreScript([variables, aliases, functions].join('\u001e'), this.functions);
        for (const name of this.functions.keys()) if (!reportedFunctions(functions).has(name)) this.functions.delete(name);
        reported = true;
        const rest = fields.slice(4).join('\u001e');
        held = '';
        if (rest) this.emit(rest);
      };
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        pending += decoder.decode(value, {stream: true});
        for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
          const frame = JSON.parse(pending.slice(0, index)) as {type: string; data?: string};
          pending = pending.slice(index + 1);
          if (frame.type === 'stderr') this.emit(frame.data ?? '');
          if (frame.type === 'stdout') stdout(frame.data ?? '');
          if (frame.type === 'exit') exitCode = Number((frame as {code?: unknown}).code ?? 1);
        }
      }
      if (!reported && held) this.emit(held);
      // The command ended the script before its report: bash still runs PROMPT_COMMAND before the next prompt.
      if (!reported && this.env.PROMPT_COMMAND) await this.promptCommand(exitCode ?? 1);
    } catch (error) {
      this.emit(`weft: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (this.running === id) {this.running = undefined; this.revision++;}
      if (!this.closed) this.prompt();
    }
  }

  private async promptCommand(status: number): Promise<void> {
    const response = await this.transport.exec({id: crypto.randomUUID(), command: `${this.state}\n(exit ${status}); eval "\${PROMPT_COMMAND:-}"`, cwd: this.cwd, env: this.env, sandbox: {mode: 'read-only', root: '/workspace'}});
    if (!response.ok || !response.body) return;
    for (const line of (await response.text()).split('\n')) {
      if (!line) continue;
      const frame = JSON.parse(line) as {type: string; data?: string};
      if (frame.type === 'stdout') this.emit(frame.data ?? '');
    }
  }

  async resize(): Promise<void> {}
  /** The shell's own group while it waits at its prompt, a command's group while one runs. */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.running ? {processGroupId: this.pid + 1, inputWaiting: false} : {processGroupId: this.pid, inputWaiting: true};
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
