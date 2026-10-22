import {createServer} from 'node:http';
import {timingSafeEqual, randomUUID, createHash} from 'node:crypto';
import {once} from 'node:events';
import {realpathSync} from 'node:fs';
import {Context} from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import {RpcTarget, newWebSocketRpcSession} from 'capnweb';
import {WebSocketServer} from 'ws';

// The launch secret never enters a child process or appears in protocol results.
const secret = process.env.RPC_CLIENT_SECRET;
delete process.env.RPC_CLIENT_SECRET;
if (!secret) throw new Error('The process service requires RPC_CLIENT_SECRET');
const generation = randomUUID();
const ctx = new Context();
await ctx.plugin(LocalSubprocess);
await ctx.plugin(LocalSandbox, {});
const records = new Map();
const starts = new Map();
const IDLE_MS = 10 * 60_000;
const CAP = 128 * 1024;

// Acked offsets permit bounded replay across transport reconnects. Pausing the
// original Readable propagates backpressure into node-pty / the child's pipes.
class Output {
  chunks = []; base = 0; end = 0; bytes = 0; stream; draining = false;
  constructor(stream, changed) {
    this.stream = stream;
    stream?.on('data', chunk => {
      const bytes = Buffer.from(chunk).subarray(0, this.draining ? Math.max(0, CAP - this.bytes) : undefined);
      this.chunks.push(bytes); this.bytes += bytes.length; this.end += bytes.length;
      if (this.bytes >= CAP && !this.draining) stream.pause();
      changed();
    });
    stream?.on('error', error => changed(error));
  }
  drain() {this.draining = true; this.stream?.resume();}
  read(offset) {
    if (!Number.isSafeInteger(offset) || offset < this.base || offset > this.end) throw new Error('Process output replay window exceeded');
    let skip = offset - this.base;
    while (skip && this.chunks.length) {
      const head = this.chunks[0];
      const count = Math.min(skip, head.length);
      if (count === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(count);
      skip -= count; this.base += count; this.bytes -= count;
    }
    if (this.bytes < CAP / 2) this.stream?.resume();
    return new Uint8Array(Buffer.concat(this.chunks, this.bytes).subarray(0, 64 * 1024));
  }
}

function validate(spec) {
  if (!spec || !['pipe', 'pty'].includes(spec.kind) || !Array.isArray(spec.argv) || !spec.argv.length || spec.argv.length > 256 || spec.argv.some(word => typeof word !== 'string' || word.includes('\0')) || JSON.stringify(spec).length > 512 * 1024) throw new Error('Invalid process specification');
  if (!Number.isFinite(spec.graceMs) || spec.graceMs < 1 || spec.graceMs > 30_000) throw new Error('Invalid process termination grace');
  const cwd = realpathSync(spec.cwd);
  const root = realpathSync(spec.sandbox?.root ?? '/workspace');
  if (![cwd, root].every(path => path === '/workspace' || path.startsWith('/workspace/'))) throw new Error('Process directory is outside /workspace');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(spec.sandbox?.mode)) throw new Error('Invalid process sandbox');
  if (spec.kind === 'pty' && (![spec.rows, spec.cols].every(n => Number.isInteger(n) && n > 0 && n <= 1000) || typeof spec.terminalType !== 'string')) throw new Error('Invalid terminal dimensions');
  if (spec.env && (Object.keys(spec.env).length > 256 || Object.entries(spec.env).some(([name, value]) => name === 'RPC_CLIENT_SECRET' || name.includes('\0') || name.includes('=') || typeof value !== 'string' || value.includes('\0')))) throw new Error('Invalid child environment');
  return {...spec, cwd, sandbox: {mode: spec.sandbox.mode, root}};
}

class Processes extends RpcTarget {
  constructor(owner) {super(); this.owner = owner;}
  info() {return {generation};}
  #key(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid process id');
    return `${this.owner}/${id}`;
  }
  #record(id) {
    const record = records.get(this.#key(id));
    if (!record) throw new Error('Process no longer exists; the container may have restarted');
    return record;
  }
  resolve(command, env) {return ctx.subprocess.resolveExecutable(command, env);}
  async confine(policy) {
    if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || typeof policy.root !== 'string') throw new Error('Invalid process sandbox');
    const root = realpathSync(policy.root);
    if (root !== '/workspace' && !root.startsWith('/workspace/')) throw new Error('Sandbox root is outside /workspace');
    if (policy.mode === 'danger-full-access') return {enforcement: 'full', denialSignatures: [], runnerFailureRules: []};
    const confined = await ctx.sandbox.confine(['/bin/true'], {mode: policy.mode, workspaceRoot: policy.root});
    return {enforcement: confined.enforcement, denialSignatures: [...confined.denialSignatures], runnerFailureRules: [...confined.runnerFailureRules]};
  }
  async start(id, raw) {
    const key = this.#key(id);
    const signature = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    const existing = starts.get(key);
    if (existing) {
      if (existing.signature !== signature) throw new Error('Process id already belongs to another command');
      return existing.promise;
    }
    if (starts.size >= 8192) throw new Error('Container process receipt limit reached; restart the workspace container');
    const owned = [...records.entries()].filter(([, record]) => !record.quiet);
    if (records.size >= 256 || owned.length >= 32 || owned.filter(([key]) => key.startsWith(this.owner + '/')).length >= 16) throw new Error('Container process limit reached');
    const promise = this.#create(key, raw);
    starts.set(key, {signature, promise});
    // Keep a rejected start as a receipt: an ambiguous retry must never execute twice.
    return promise;
  }
  async #create(key, raw) {
    const spec = validate(raw);
    let argv = spec.argv;
    if (spec.sandbox.mode !== 'danger-full-access') argv = [...(await ctx.sandbox.confine(argv, {mode: spec.sandbox.mode, workspaceRoot: spec.sandbox.root})).argv];
    const launch = {argv, cwd: spec.cwd, env: spec.env, graceMs: spec.graceMs};
    const handle = spec.kind === 'pty'
      ? await ctx.subprocess.spawnTerminal({...launch, rows: spec.rows, cols: spec.cols, terminalType: spec.terminalType, shellActivity: spec.shellActivity})
      : ctx.subprocess.spawn({...launch, stdio: {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ...(spec.control ? {control: 'pipe'} : {})}});
    const record = {handle, kind: spec.kind, trackedShell: spec.shellActivity === true, lastInput: Date.now(), lastRead: Date.now(), sequences: {stdin: 0, control: 0}, inputErrors: {}, writes: {stdin: Promise.resolve(), control: Promise.resolve()}, waiters: new Set(), quiet: false, outcome: undefined, error: undefined};
    const changed = error => {
      if (error) record.error = error.message;
      for (const wake of record.waiters) wake();
      record.waiters.clear();
    };
    record.logs = {
      stdout: new Output(spec.kind === 'pty' ? handle.output : handle.stdout, changed),
      stderr: new Output(spec.kind === 'pty' ? undefined : handle.stderr, changed),
      control: new Output(spec.kind === 'pty' ? undefined : handle.control, changed),
    };
    records.set(key, record);
    handle.done.then(outcome => {
      record.outcome = outcome; changed();
      if (spec.kind === 'pipe') void handle.waitForExit().then(quiet => {record.quiet = quiet;}).catch(() => {});
      else record.quiet = !record.trackedShell;
    }, error => changed(error));
    return {pid: handle.pid ?? 0};
  }
  async read(id, offsets) {
    const record = this.#record(id);
    record.lastRead = Date.now();
    if (!record.outcome && !record.error && Object.entries(record.logs).every(([name, log]) => offsets[name] === log.end)) {
      await new Promise(resolve => {
        const wake = () => {clearTimeout(timer); record.waiters.delete(wake); resolve();};
        const timer = setTimeout(wake, 1000);
        record.waiters.add(wake);
      });
    }
    const busy = record.kind !== 'pty' || (await record.handle.inspectActivity()).state !== 'idle';
    if (record.outcome && !busy) record.quiet = true;
    const result = {offsets: {}, active: !record.outcome && !record.error && busy};
    for (const [name, log] of Object.entries(record.logs)) {
      result[name] = log.read(offsets[name]);
      result.offsets[name] = offsets[name] + result[name].length;
    }
    const drained = Object.entries(record.logs).every(([name, log]) => result.offsets[name] === log.end);
    if (drained && record.outcome) result.outcome = record.outcome;
    if (record.error) result.error = record.error;
    return result;
  }
  write(id, sequence, channel, data, end) {
    const record = this.#record(id);
    if (!['stdin', 'control'].includes(channel) || !(data instanceof Uint8Array) || data.length > 65536 || !Number.isSafeInteger(sequence)) throw new Error('Invalid process input');
    const operation = record.writes[channel].then(async () => {
      if (record.inputErrors[channel]) throw record.inputErrors[channel];
      if (sequence <= record.sequences[channel]) return;
      if (sequence !== record.sequences[channel] + 1) throw new Error('Process input sequence gap');
      // Record before touching the process: a transport retry never duplicates keyboard input.
      record.sequences[channel] = sequence; record.lastInput = Date.now();
      if (record.kind === 'pty') {if (channel !== 'stdin' || end) throw new Error('Invalid PTY input'); await record.handle.write(Buffer.from(data).toString('utf8'));}
      else {
        const stream = channel === 'control' ? record.handle.control : record.handle.stdin;
        if (!stream) throw new Error('Process channel unavailable');
        if (data.length && !stream.write(Buffer.from(data))) await once(stream, 'drain');
        if (end) stream.end();
      }
    });
    record.writes[channel] = operation.catch(error => {record.inputErrors[channel] = error;});
    return operation;
  }
  resize(id, cols, rows) {
    if (![cols, rows].every(n => Number.isInteger(n) && n > 0 && n <= 1000)) throw new Error('Invalid terminal dimensions');
    return this.#record(id).handle.resize(cols, rows);
  }
  foreground(id) {return this.#record(id).handle.inspectForeground();}
  activity(id) {return this.#record(id).handle.inspectActivity();}
  signal(id, signal) {
    if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'].includes(signal)) throw new Error('Invalid process signal');
    return this.#record(id).handle.signalForeground(signal);
  }
  async terminate(id) {
    const record = this.#record(id);
    for (const log of Object.values(record.logs)) log.drain();
    // Kill before waiting for input: a child may have stopped reading its pipe.
    await record.handle.terminate();
  }
  async wait(id) {
    const record = this.#record(id);
    if (record.kind === 'pty') return record.outcome !== undefined;
    const abort = AbortSignal.timeout(500);
    return record.handle.waitForExit(abort);
  }
}

const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404); response.end(request.url === '/health' ? 'ok' : 'Not found');
});
const sockets = new WebSocketServer({noServer: true, maxPayload: 2 * 1024 * 1024});
server.on('upgrade', (request, socket, head) => {
  const received = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  const owner = request.headers['x-weft-process-owner'];
  if (received.length !== expected.length || !timingSafeEqual(received, expected) || typeof owner !== 'string' || !/^[\w-]{1,100}$/.test(owner)) {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;}
  sockets.handleUpgrade(request, socket, head, ws => {newWebSocketRpcSession(ws, new Processes(owner));});
});
const sweep = setInterval(() => {
  for (const [key, record] of records) {
    if ((record.quiet || record.error) && Date.now() - record.lastRead > 60_000) {
      void record.handle.terminate().then(() => {records.delete(key);}).catch(() => {});
    }
    else if (record.kind === 'pty' && Date.now() - record.lastInput > IDLE_MS) {
      void record.handle.inspectActivity().then(activity => {if (activity.state === 'idle') return record.handle.terminate();}).catch(() => {});
    }
  }
}, 30_000);
server.listen(8081, '0.0.0.0');
async function shutdown() {
  clearInterval(sweep);
  for (const client of sockets.clients) client.close();
  await ctx.fiber.dispose();
  server.close();
}
process.once('SIGTERM', () => {void shutdown();});
process.once('SIGINT', () => {void shutdown();});
