import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {build} from 'esbuild';
import WebSocket from 'ws';
import {newWebSocketRpcSession} from 'capnweb';
import type {ProcessService, ProcessSpec, ProcessOffsets} from '../packages/workspace/src/process-protocol.ts';
import type {WorkspaceOperation} from '../packages/workspace/src/protocol.ts';
import type {Readable} from 'node:stream';

const run = promisify(execFile);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const zero = (): ProcessOffsets => ({stdout: 0, stderr: 0, control: 0});
const secret = 'weft-process-integration-test';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const readAll = async (stream: Readable) => {const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);};

/** Opt-in Docker + FUSE + original dsh subprocess runtime, without a production deployment. */
test('real processes, PTYs, sandbox, reconnect and durable file synchronization', {skip: process.env.WEFT_PROCESS_TESTS !== '1', timeout: 180_000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-process-'));
  const name = `weft-process-${crypto.randomUUID()}`;
  const docker = (...args: string[]) => run('docker', args, {timeout: 120_000, maxBuffer: 2 * 1024 * 1024});
  const image = process.env.WEFT_CONTAINER_IMAGE ?? JSON.parse(await readFile('apps/workspace-container/image.json', 'utf8')).reference;
  const connections: {close(): void}[] = [];
  try {
    await docker('run', '-d', '--name', name, '--memory', '2g', '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined',
      '-e', `RPC_CLIENT_SECRET=${secret}`, '-e', 'MOUNT_IGNORE=/.weft,**/node_modules,**/.venv', '-p', '127.0.0.1::8081', '-p', '127.0.0.1::8080', image);
    const port = async (number: number) => Number((await docker('port', name, String(number))).stdout.trim().split(':').pop());
    const processPort = await port(8081), computerPort = await port(8080);
    for (let attempt = 0;; attempt++) {
      try {await docker('exec', name, 'mountpoint', '-q', '/workspace'); if ((await fetch(`http://127.0.0.1:${processPort}/health`)).ok) break;}
      catch (error) {if (attempt > 100) throw error;}
      await pause(100);
    }
    const connect = async (owner = 'session-a', endpoint = processPort, auth = secret) => {
      const socket = new WebSocket(`ws://127.0.0.1:${endpoint}/${endpoint === computerPort ? 'api' : 'connect'}`, {headers: {authorization: `Bearer ${auth}`, 'x-weft-process-owner': owner}});
      await once(socket, 'open');
      const api = newWebSocketRpcSession<ProcessService>(socket as unknown as globalThis.WebSocket);
      const close = () => {api[Symbol.dispose](); socket.close();};
      connections.push({close});
      return {api, socket, close};
    };
    let {api} = await connect();
    const base = (argv: string[], kind: 'pipe' | 'pty' = 'pipe'): ProcessSpec => ({kind, argv, cwd: '/workspace', sandbox: {mode: 'danger-full-access', root: '/workspace'}, graceMs: 300,
      ...(kind === 'pty' ? {rows: 24, cols: 80, terminalType: 'xterm-256color', shellActivity: true} : {})});
    const drain = async (id: string) => {
      let offsets = zero();const stdout: Buffer[] = [], stderr: Buffer[] = [], control: Buffer[] = [];
      for (;;) {
        const frame = await api.read(id, offsets); offsets = frame.offsets;
        stdout.push(Buffer.from(frame.stdout));stderr.push(Buffer.from(frame.stderr));control.push(Buffer.from(frame.control));
        assert.equal(frame.error, undefined);
        if (frame.outcome) return {outcome: frame.outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), control: Buffer.concat(control)};
      }
    };

    await t.test('auth, session ownership, duplicate start and reconnect input receipts', async () => {
      await assert.rejects(connect('bad', processPort, 'wrong'), /403/);
      const spec = base(['/bin/sh', '-c', 'cat']);
      const first = await api.start('cat', spec);
      assert.deepEqual(await api.start('cat', spec), first);
      await assert.rejects(Promise.resolve(api.start('cat', base(['/bin/true']))), /another command/);
      const other = await connect('session-b');
      await assert.rejects(Promise.resolve(other.api.write('cat', 1, 'stdin', bytes('bad'), false)), /no longer exists/);
      await api.write('cat', 1, 'stdin', bytes('once'), false);
      ({api} = await connect());
      await api.write('cat', 1, 'stdin', bytes('once'), false);
      await api.write('cat', 2, 'stdin', new Uint8Array(), true);
      const result = await drain('cat');
      assert.equal(result.stdout.toString(), 'once');assert.equal(result.outcome.exitCode, 0);
      await assert.rejects(Promise.resolve(api.start('escape', {...spec, cwd: '/etc'})), /outside/);
      await assert.rejects(Promise.resolve(api.start('env-secret', {...spec, env: {RPC_CLIENT_SECRET: 'bad'}})), /environment/);
    });

    await t.test('binary stdout/stderr, bidirectional control fd, and large piped stdin with backpressure', async () => {
      const size = 2 * 1024 * 1024;
      await api.start('binary', base(['python3', '-c', 'import sys; d=sys.stdin.buffer.read(); sys.stdout.buffer.write(d); sys.stderr.buffer.write(bytes([255,0,65]))']));
      const draining = drain('binary');
      const chunk = new Uint8Array(65536).map((_, i) => i % 251);
      for (let i = 0; i < size / chunk.length; i++) await api.write('binary', i + 1, 'stdin', chunk, false);
      await api.write('binary', size / chunk.length + 1, 'stdin', new Uint8Array(), true);
      const result = await draining;
      assert.equal(result.stdout.length, size);assert.deepEqual(result.stdout.subarray(-65536), Buffer.from(chunk));assert.deepEqual(result.stderr, Buffer.from([255, 0, 65]));
      await api.start('control', {...base(['python3', '-c', 'import os; os.write(7,os.read(7,20).upper())']), control: true});
      await api.write('control', 1, 'control', bytes('control'), false);
      assert.equal((await drain('control')).control.toString(), 'CONTROL');
      await api.start('control-gate', {...base(['python3', '-c', 'import os,sys; os.read(7,2); d=sys.stdin.buffer.read(); print(len(d))']), control: true});
      const gateOutput = drain('control-gate');
      const feeding = (async () => {for (let i=1;i<=16;i++) await api.write('control-gate', i, 'stdin', chunk, false);await api.write('control-gate', 17, 'stdin', new Uint8Array(), true);})();
      await pause(100);await api.write('control-gate', 1, 'control', bytes('go'), false);await feeding;
      assert.equal((await gateOutput).stdout.toString().trim(), String(16 * chunk.length));
    });

    await t.test('real PTY: persistent shell, Python input, resize, foreground signal and detach', async () => {
      const {pid} = await api.start('terminal', base(['/bin/bash', '--noprofile', '--norc', '-i'], 'pty'));assert.ok(pid > 0);
      let offsets = zero(), screen = '', sequence = 0;
      const until = async (pattern: RegExp) => {
        const deadline = Date.now() + 10_000;
        while (!pattern.test(screen)) {assert.ok(Date.now() < deadline, `${pattern}: ${screen}`);const frame = await api.read('terminal', offsets);offsets = frame.offsets;screen += text(frame.stdout);assert.equal(frame.error, undefined);}
        screen = '';
      };
      const type = (data: string) => api.write('terminal', ++sequence, 'stdin', bytes(data), false);
      await until(/bash.*# /);
      await type("export PROBE=kept; mkdir -p pty-sub; cd pty-sub; printf 'STATE:%s:%s\\n' \"$PROBE\" \"$PWD\"\r");await until(/STATE:kept:\/workspace\/pty-sub\r\n/);
      await api.resize('terminal', 103, 37);await type('stty size\r');await until(/37 103\r\n/);
      await type("python3 -c 'import os; print(\"TTY:\",os.isatty(0),flush=True); print(\"INPUT:\"+input(),flush=True)'\r");await until(/TTY: True\r\n/);
      await type('hello\r');await until(/INPUT:hello\r\n/);
      await type('sleep 30\r');await pause(150);
      assert.ok(await api.foreground('terminal'));
      assert.ok(await api.signal('terminal', 'SIGINT') > 0);await until(/bash.*# /);
      ({api} = await connect());await type('printf "RECONNECTED:%s\\n" "$PROBE"\r');await until(/RECONNECTED:kept\r\n/);
      await type('exit\r');assert.equal((await drainFrom('terminal', offsets)).exitCode, 0);
      async function drainFrom(id: string, current: ProcessOffsets) {for (;;) {const frame = await api.read(id, current);current = frame.offsets;if (frame.outcome) return frame.outcome;}}
    });

    await t.test('kernel sandbox enforces read-only and workspace-write file effects', async () => {
      const policy = {mode: 'workspace-write' as const, root: '/workspace'};
      assert.ok(['full', 'partial'].includes((await api.confine(policy)).enforcement));
      await api.start('allowed', {...base(['/bin/sh', '-c', 'echo yes > /workspace/allowed; echo denied > /etc/weft-forbidden']), sandbox: policy});
      const allowed = await drain('allowed');assert.notEqual(allowed.outcome.exitCode, 0);assert.match(allowed.stderr.toString(), /denied|read-only/i);
      await api.start('readonly', {...base(['/bin/sh', '-c', 'echo denied > /workspace/readonly']), sandbox: {...policy, mode: 'read-only'}});
      assert.notEqual((await drain('readonly')).outcome.exitCode, 0);
      const exists = await docker('exec', name, '/bin/sh', '-c', 'cat /workspace/allowed; test ! -e /workspace/readonly && test ! -e /etc/weft-forbidden');assert.equal(exists.stdout.trim(), 'yes');
    });

    await t.test('termination kills descendants even when stdin and output are blocked', async () => {
      await api.start('blocked', base(['/bin/sh', '-c', 'sleep 120 & echo $! > /workspace/child.pid; exec sleep 120']));
      const writing = api.write('blocked', 1, 'stdin', new Uint8Array(65536), false).catch(() => {});
      await pause(100);await api.terminate('blocked');await writing;
      assert.equal(await api.wait('blocked'), true);
      await docker('exec', name, 'python3', '-c', 'import pathlib; p=pathlib.Path("/proc/"+pathlib.Path("/workspace/child.pid").read_text().strip()); assert not p.exists() or ") Z " in (p/"stat").read_text()');
    });

    await t.test('production Worker adapter handles raw input, control and terminal lifecycle', async () => {
      await writeFile(join(directory, 'package.json'), '{"version":"0.0.0"}');
      const bundle = join(directory, 'host', 'host.mjs');
      await build({entryPoints: ['tests/fixtures/process-host.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error',
        plugins: [{name: 'cloudflare-test-base', setup(builder) {
          builder.onResolve({filter: /^cloudflare:workers$/}, () => ({path: 'base', namespace: 'cloudflare-test'}));
          builder.onLoad({filter: /.*/, namespace: 'cloudflare-test'}, () => ({contents: "export {RpcTarget} from 'capnweb'; export class WorkerEntrypoint {}", resolveDir: process.cwd()}));
        }}]});
      const host = await import(pathToFileURL(bundle).href) as typeof import('./fixtures/process-host.ts');
      let syncs = 0;
      const {ctx, subprocess} = await host.boot({container: () => true,
        connectProcess: async () => {const {socket} = await connect('adapter');(socket as unknown as {accept(): void}).accept = () => {};return {webSocket: socket, headers: new Headers()} as unknown as Response;},
        syncProcesses: async () => {syncs++;}, exec: async () => {throw Error('unexpected legacy exec');}, kill: async () => {}});
      try {
        // The browser's shell discovery probes optional shells before creating
        // a terminal. Their custom not-found errors cross the real RPC boundary.
        const shells = await host.discoverShells(subprocess, undefined, ['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'], new AbortController().signal);
        assert.deepEqual(shells.map(shell => shell.path), ['/bin/bash']);
        for (const command of ['weft-missing-shell', '/bin/weft-missing-shell']) {
          await assert.rejects(subprocess.resolveExecutable(command), {name: 'SubprocessExecutableNotFoundError'});
        }
        await assert.rejects(subprocess.resolveExecutable('./bash'), {name: 'Error', message: /relative path/});
        const pipe = subprocess.spawn({argv: ['python3', '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.write("err")'], cwd: '/workspace', graceMs: 300,
          stdio: {stdin: {data: 'x'.repeat(2 * 1024 * 1024)}, stdout: {maxBytes: 3 * 1024 * 1024}, stderr: {maxBytes: 1024}}});
        assert.equal((await pipe.done).exitCode, 0);assert.equal(pipe.collected.stdout?.readFrom(0).text.length, 2 * 1024 * 1024);assert.match(pipe.collected.stderr?.readFrom(0).text ?? '', /err$/);
        assert.equal(await pipe.waitForExit(), true);
        const control = subprocess.spawn({argv: ['python3', '-c', 'import os; os.write(7,os.read(7,20).upper())'], cwd: '/workspace', graceMs: 300, stdio: {stdin: 'ignore', stdout: {maxBytes: 1024}, stderr: {maxBytes: 1024}, control: 'pipe'}});
        const reading = readAll(control.control!);control.control!.write('adapter');
        assert.equal((await reading).toString(), 'ADAPTER');assert.equal((await control.done).exitCode, 0);await control.waitForExit();
        const shell = shells[0]!;
        const terminal = await subprocess.spawnTerminal({argv: [shell.path, ...shell.args], cwd: '/workspace', graceMs: 300, rows: 24, cols: 80, terminalType: 'xterm-256color', shellActivity: true});
        const output = readAll(terminal.output);await terminal.write("printf 'ADAPTER:%s\\n' \"$(tty)\"; exit\r");assert.equal((await terminal.done).exitCode, 0);assert.match((await output).toString(), /ADAPTER:\/dev\/pts\//);assert.ok(syncs >= 6);

        const blocked = subprocess.spawn({argv: ['python3', '-c', 'import sys,time; sys.stdout.buffer.write(b"x"*2097152); sys.stdout.flush(); time.sleep(120)'], cwd: '/workspace', graceMs: 300,
          stdio: {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'}});
        await pause(150);blocked.terminate();await blocked.done;assert.equal(await blocked.waitForExit(), true);
        const blockedPty = await subprocess.spawnTerminal({argv: ['python3', '-c', 'import sys,time; sys.stdout.write("x"*2097152); sys.stdout.flush(); time.sleep(120)'], cwd: '/workspace', graceMs: 300, rows: 24, cols: 80, terminalType: 'xterm-256color'});
        await pause(150);await blockedPty.terminate();await blockedPty.done;

        const background = subprocess.spawn({argv: ['/bin/sh', '-c', 'echo keep > /workspace/stop-kept.txt; sleep 120'], cwd: '/workspace', graceMs: 300,
          stdio: {stdin: 'ignore', stdout: {maxBytes: 1024}, stderr: {maxBytes: 1024}}});
        const openTerminal = await subprocess.spawnTerminal({argv: ['/bin/bash', '-i'], cwd: '/workspace', graceMs: 300, rows: 24, cols: 80, terminalType: 'xterm-256color'});
        await pause(150);
        await (subprocess as import('../packages/workspace/src/subprocess.ts').WorkspaceSubprocess).stopContainerProcesses();
        await Promise.allSettled([background.done, openTerminal.done]);
        assert.equal((await docker('exec', name, 'cat', '/workspace/stop-kept.txt')).stdout.trim(), 'keep');
        const fresh = subprocess.spawn({argv: ['/bin/echo', 'fresh-after-stop'], cwd: '/workspace', graceMs: 300,
          stdio: {stdin: 'ignore', stdout: {maxBytes: 1024}, stderr: {maxBytes: 1024}}});
        assert.equal((await fresh.done).exitCode, 0);
        assert.match(fresh.collected.stdout!.readFrom(0).text, /fresh-after-stop/);

        let epoch = 0, admitted = 0;
        const sockets: WebSocket[] = [];
        const fenced = new host.ContainerProcessClient(async requested => {
          if (requested !== undefined && requested !== epoch) return new globalThis.Response('Container connection has ended', {status: 409});
          admitted++;
          const {socket} = await connect('fenced'); sockets.push(socket);
          (socket as unknown as {accept(): void}).accept = () => {};
          return {webSocket: socket, headers: new Headers({'x-weft-container-epoch': String(epoch)})} as unknown as globalThis.Response;
        }, async () => {});
        await fenced.call(api => api.info());
        const closed = once(sockets[0]!, 'close'); sockets[0]!.close(); await closed;
        epoch++;
        await assert.rejects(fenced.call(api => api.info()), /connection has ended/);
        assert.equal(admitted, 1, 'an old process reconnect is rejected before any container connection can start');
        assert.equal(fenced.ended, true);

        // The production sync implementation against real computerd/FUSE, with a SQLite DO storage adapter.
        const computer = await connect('sync', computerPort);
        const db = new DatabaseSync(':memory:');
        const storage = {sql: {exec(query: string, ...bindings: unknown[]) {
          const statement = db.prepare(query);
          const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
          const rows = statement.all(...values as (string | number | null | Uint8Array)[]);
          return {toArray: () => rows, one: () => {assert.equal(rows.length, 1);return rows[0];}, [Symbol.iterator]: () => rows[Symbol.iterator]()};
        }}, transactionSync: <T>(callback: () => T): T => callback(), sync: async () => {}} as unknown as DurableObjectStorage;
        const store = new host.WorkspaceStore(storage, {observer: {span: (_name, _attrs, next) => next({setAttribute() {}})}, backends: [{id: 'test', type: 'container',
          connect: async () => ({rpc: computer.api as never, runtimeId: 'test-runtime', close: async () => {}})}]});
        const write = (path: string, content: string) => store.execute({type: 'write', path, content});
        const read = (path: string) => store.execute({type: 'read', path}) as {content: string; version: string};
        write('/workspace/sync.txt', 'before');await store.synchronize('test', false);
        assert.equal((await docker('exec', name, 'cat', '/workspace/sync.txt')).stdout, 'before');
        const before = read('/workspace/sync.txt');
        await docker('exec', name, '/bin/sh', '-c', 'echo after > /workspace/sync.txt; mkdir -p /workspace/new; echo created > /workspace/new/file.txt');
        const changed = await store.synchronize('test', true);
        assert.ok(changed.includes('/workspace/sync.txt'));assert.equal(read('/workspace/sync.txt').content, 'after\n');assert.equal(read('/workspace/new/file.txt').content, 'created\n');assert.notEqual(read('/workspace/sync.txt').version, before.version);
        assert.throws(() => store.execute({type: 'write', path: '/workspace/sync.txt', content: 'stale', expected: {kind: 'replaceIfVersion', version: before.version}} as WorkspaceOperation), /changed/);
        await docker('exec', name, 'rm', '-rf', '/workspace/new');await store.synchronize('test', true);assert.equal(store.execute({type: 'stat', path: '/workspace/new/file.txt'}), null);
        write('/workspace/tool-edit.txt', 'tool writes');await store.synchronize('test', true);assert.equal((await docker('exec', name, 'cat', '/workspace/tool-edit.txt')).stdout, 'tool writes');
        db.close();
      } finally {await ctx.fiber.dispose();}
    });
  } finally {
    for (const connection of connections) connection.close();
    await docker('rm', '-f', name).catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
