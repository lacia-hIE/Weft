/**
 * The PTC runtime of a Weft Session: each program runs in its own Dynamic
 * Worker with no network egress, and its binding calls come back to the
 * Session world over RPC. The official `tools` presentation (`run_code`) and
 * `tool-presentation` rows consume it as they consume the Node runtime.
 */
import { RpcTarget } from 'cloudflare:workers';
import type { Context } from '@deepseek-ai/cordis';
import { PtcRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime';
import type { PtcBindingNamespace, PtcJsonValue, PtcRunFailure, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { transform } from 'sucrase';

export interface Config {
  /** Absent where programs never run (preset inspection) or the deployment has no Worker Loader. */
  loader?: WorkerLoader;
  /** Default working directory reported to programs. */
  cwd: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STRIP_PREFIX = 'async function __dsh_program__() {\n';
const STRIP_SUFFIX = '\n}';
/** CPU budget of one program isolate; wall time is the run's own deadline. */
const CPU_MS = 30_000;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** The guest: console capture, binding namespaces and lossless-JSON checks around the program module. */
const RUNNER = String.raw`
import { WorkerEntrypoint } from 'cloudflare:workers';
import { inspect } from 'node:util';
import program from './program.js';
const INSPECT = { depth: 4, maxArrayLength: 100, maxStringLength: 10000 };
function snapshot(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) return undefined; const item = snapshot(value[i]); if (item === undefined) return undefined; out.push(item); }
    return out;
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out = {};
    for (const key of Object.keys(value)) { const item = snapshot(value[key]); if (item === undefined) return undefined; Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true }); }
    return out;
  }
  return undefined;
}
export default class extends WorkerEntrypoint {
  async run(host, namespaces) {
    const sent = [];
    const render = args => args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT)).join(' ');
    const console = Object.create(null);
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => { sent.push(host.log(render(args))); };
    const values = [], classes = [];
    for (const { global, names, errorClass } of namespaces) {
      let ErrorClass;
      if (errorClass) {
        ErrorClass = class extends Error {
          constructor(message, member) {
            super(message);
            Object.defineProperty(this, 'name', { value: errorClass.name, writable: true, configurable: true });
            Object.defineProperty(this, errorClass.memberNameProperty, { value: member, enumerable: true, writable: true, configurable: true });
          }
        };
        Object.defineProperty(ErrorClass, 'name', { value: errorClass.name });
        classes.push(ErrorClass);
      }
      const failure = (name, message) => ErrorClass ? new ErrorClass(message, name) : new Error(message);
      const namespace = Object.create(null);
      for (const name of names) Object.defineProperty(namespace, name, { enumerable: true, value: async args => {
        const detached = snapshot(args);
        if (detached === undefined) throw failure(name, 'binding arguments must be lossless JSON');
        const reply = await host.call(global, name, detached);
        if (!reply.ok) throw failure(name, reply.message);
        return reply.value;
      } });
      values.push(namespace);
    }
    let done;
    try {
      const value = await program(...values, ...classes, console);
      if (value === undefined) done = {};
      else {
        const detached = snapshot(value);
        done = detached === undefined ? { error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } } : { value: detached };
      }
    } catch (error) {
      let message;
      try { message = error instanceof Error ? error.stack ?? error.message : String(error); } catch { message = 'program threw an unrenderable value'; }
      done = { error: { kind: 'exception', message } };
    }
    await Promise.allSettled(sent);
    return done;
  }
}`;

/** Binding namespaces as the Node runtime validates them, so one request is valid on both. */
function validateBindings(request: PtcRunRequest): Map<string, PtcBindingNamespace> {
  const bindings = new Map<string, PtcBindingNamespace>();
  const globals = new Set<string>();
  const claim = (name: string, what: string) => {
    if (!IDENTIFIER.test(name) || PORTABLE_RESERVED_WORDS.has(name)) throw new Error(`weft-ptc: ${what} ${JSON.stringify(name)} is not a usable identifier`);
    if (RESERVED_BINDING_GLOBALS.has(name)) throw new Error(`weft-ptc: reserved binding global ${JSON.stringify(name)}`);
    if (globals.has(name)) throw new Error(`weft-ptc: duplicate injected global ${JSON.stringify(name)}`);
    globals.add(name);
  };
  for (const namespace of request.bindings) { claim(namespace.global, 'binding global'); bindings.set(namespace.global, namespace); }
  for (const namespace of request.bindings) {
    const descriptor = namespace.errorClass;
    if (!descriptor) continue;
    claim(descriptor.name, 'binding error class');
    const member = descriptor.memberNameProperty;
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) throw new Error(`weft-ptc: binding error member property ${JSON.stringify(member)} is not usable`);
  }
  return bindings;
}

/** `import("data:text/javascript,…")` with a JSON string literal, as consumers such as workflow-ptc load their guest code. */
const DATA_IMPORT = /import\(\s*("data:text\/javascript,(?:[^"\\\n]|\\.)*")\s*\)/g;

/**
 * The program as the default export of a module, its parameters the injected
 * globals. Workers load no code from URLs, so inline `data:` module imports
 * become modules of the same isolate.
 */
function programModules(program: string, bindings: Map<string, PtcBindingNamespace>): Record<string, string> {
  const modules: Record<string, string> = {};
  const inlined = program.replace(DATA_IMPORT, (_match, literal: string) => {
    const name = `data-${Object.keys(modules).length}.js`;
    modules[name] = decodeURIComponent((JSON.parse(literal) as string).slice('data:text/javascript,'.length));
    return `import(${JSON.stringify('./'+name)})`;
  });
  const stripped = transform(STRIP_PREFIX + inlined + STRIP_SUFFIX, {transforms: ['typescript'], disableESTransforms: true, filePath: 'program.ts'}).code;
  const body = stripped.slice(stripped.indexOf(STRIP_PREFIX) + STRIP_PREFIX.length, stripped.lastIndexOf(STRIP_SUFFIX));
  const params = [...bindings.values()].map(binding => binding.global);
  for (const binding of bindings.values()) if (binding.errorClass) params.push(binding.errorClass.name);
  modules['program.js'] = `export default async function (${[...params, 'console'].join(', ')}) {\n${body}\n}\n`;
  return modules;
}

/** The Session side of one run: binding dispatch and log admission until it settles. */
class RunHost extends RpcTarget {
  readonly logs: string[] = [];
  private bytes = 0;
  closed = false;
  constructor(private readonly bindings: Map<string, PtcBindingNamespace>, private readonly maxOutputBytes: number, private readonly overflow: () => void) { super(); }
  log(text: string): void {
    if (this.closed || typeof text !== 'string') return;
    this.bytes += new TextEncoder().encode(text).byteLength;
    if (this.bytes > this.maxOutputBytes) { this.overflow(); return; }
    this.logs.push(text);
  }
  async call(global: string, name: string, args: unknown): Promise<{ok: true; value: PtcJsonValue} | {ok: false; message: string}> {
    try {
      if (this.closed) throw new Error('the program run is over');
      const functions = this.bindings.get(global)?.functions;
      const fn = functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined;
      if (typeof fn !== 'function') throw new Error('program requested an undeclared binding');
      const detached = snapshotJsonValue(args);
      if (detached === undefined) throw new Error('binding arguments must be lossless JSON');
      const value = snapshotJsonValue(await fn(detached)) as PtcJsonValue | undefined;
      if (value === undefined) throw new Error('binding resolution must be lossless JSON');
      return {ok: true, value};
    } catch (error) {
      return {ok: false, message: messageOf(error)};
    }
  }
}

/** Programs in per-run Dynamic Workers: stateless, no egress, bindings over RPC. */
export class WorkerPtcRuntime extends PtcRuntime {
  readonly language = 'typescript';
  readonly isolation = 'dynamic-worker';
  private readonly config: Required<Omit<Config, 'loader'>> & Pick<Config, 'loader'>;
  private readonly live = new Set<AbortController>();

  constructor(ctx: Context, config: Config) {
    super(ctx);
    this.config = {timeoutMs: 120_000, maxTimeoutMs: 600_000, maxOutputBytes: 4_194_304, ...config};
    ctx.effect(() => () => { for (const controller of this.live) controller.abort('runtime disposed'); }, 'Worker PTC runtime cleanup');
  }

  override get executionInstructions(): string {
    return 'The program is the body of an async TypeScript function; type annotations are erased before it runs. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Cloudflare Workers isolate with Web standard APIs and node: built-in modules through await import(...); it has no filesystem and no network access, so reach files and the web only through the tools object.';
  }

  /** Programs reach files only through bindings, so every Session file policy holds; report the Session's own. */
  override get sandboxMode(): SandboxMode | undefined { return this.ctx.get('sandboxPolicy')?.defaultMode; }

  override get timeout(): {defaultMs: number; maxMs: number} {
    return {defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs};
  }

  resolve(request: PtcRunRequest): PtcRunSpec {
    validateBindings(request);
    const cwd = request.cwd ?? this.config.cwd;
    if (!cwd.startsWith('/')) throw new Error('weft-ptc: cwd must be absolute');
    let timeoutMs: number | null;
    if (request.timeoutMs === null) timeoutMs = null;
    else if (request.timeoutMs === undefined) timeoutMs = this.timeout.defaultMs;
    else if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('weft-ptc: timeoutMs must be a positive finite number');
    else timeoutMs = Math.min(request.timeoutMs, this.config.maxTimeoutMs);
    return {...request, cwd, timeoutMs};
  }

  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const bindings = validateBindings(spec);
    const controller = new AbortController();
    this.live.add(controller);
    let failure: PtcRunFailure | undefined;
    const settle = Promise.withResolvers<void>();
    const fail = (next: PtcRunFailure) => { failure ??= next; settle.resolve(); };
    const host = new RunHost(bindings, this.config.maxOutputBytes, () => {
      fail({kind: 'output-limit', message: `outer output exceeded ${this.config.maxOutputBytes} bytes`});
    });
    const onAbort = () => { fail({kind: 'abort', message: messageOf(spec.signal?.aborted ? spec.signal.reason : controller.signal.reason)}); };
    spec.signal?.addEventListener('abort', onAbort, {once: true});
    controller.signal.addEventListener('abort', onAbort, {once: true});
    const timer = spec.timeoutMs === null ? undefined : setTimeout(() => { fail({kind: 'timeout', message: `execution deadline reached (${spec.timeoutMs}ms)`}); }, spec.timeoutMs);
    let value: PtcJsonValue | undefined;
    try {
      if (spec.signal?.aborted) onAbort();
      if (!this.config.loader) { fail({kind: 'sandbox-unavailable', message: 'This deployment has no Worker Loader for PTC programs'}); return this.result(host, failure, value); }
      let modules: Record<string, string>;
      try { modules = programModules(spec.program, bindings); }
      catch (error) { fail({kind: 'exception', message: messageOf(error)}); return this.result(host, failure, value); }
      const worker = this.config.loader.load({
        compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js',
        modules: {...modules, 'runner.js': RUNNER}, globalOutbound: null, limits: {cpuMs: CPU_MS},
      });
      const entry = worker.getEntrypoint() as unknown as {run(host: RunHost, namespaces: unknown): Promise<{value?: unknown; error?: PtcRunFailure}>};
      const namespaces = [...bindings.values()].map(binding => ({global: binding.global, names: Object.keys(binding.functions), ...(binding.errorClass ? {errorClass: binding.errorClass} : {})}));
      const done = entry.run(host, namespaces).then(outcome => {
        if (outcome.error) {
          const kind = outcome.error.kind === 'invalid-output' ? 'invalid-output' : 'exception';
          fail({kind, message: String(outcome.error.message)});
        } else if (outcome.value !== undefined) {
          const detached = snapshotJsonValue(outcome.value) as PtcJsonValue | undefined;
          if (detached === undefined) fail({kind: 'invalid-output', message: 'program completion must be lossless JSON'});
          else {value = detached; settle.resolve();}
        } else settle.resolve();
      }, (error: unknown) => {
        // A module that does not load is the program's own syntax; anything else is the isolate.
        const message = messageOf(error);
        fail({kind: /SyntaxError|Unexpected|Invalid or unexpected/.test(message) ? 'exception' : 'worker-exit', message});
      });
      await Promise.race([done, settle.promise]);
      await settle.promise;
      return this.result(host, failure, value);
    } finally {
      host.closed = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      this.live.delete(controller);
    }
  }

  private result(host: RunHost, failure: PtcRunFailure | undefined, value: PtcJsonValue | undefined): PtcRunResult {
    const logs = host.logs;
    if (failure) return {logs, error: failure};
    if (value !== undefined) {
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength + logs.reduce((sum, line) => sum + new TextEncoder().encode(line).byteLength, 0);
      if (size > this.config.maxOutputBytes) return {logs, error: {kind: 'output-limit', message: `outer output exceeded ${this.config.maxOutputBytes} bytes`}};
      return {logs, value};
    }
    return {logs};
  }
}

export default WorkerPtcRuntime;
