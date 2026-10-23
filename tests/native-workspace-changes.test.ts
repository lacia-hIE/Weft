import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { nativeChangesPlatform } from '../scripts/native-changes-platform.mjs';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'});

test('the official change recorder compares a nested project without including sibling workspace changes', {timeout: 120_000}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'weft-changes-'));
  try {
    // The bundle reads its attribution version from an adjacent package manifest, as the Worker build inlines it.
    await writeFile(join(scratch, 'package.json'), '{"version": "0.0.0"}');
    const bundle = join(scratch, 'host', 'host.mjs');
    await build({
      entryPoints: ['tests/fixtures/workspace-changes-host.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2024',
      tsconfig: '.generated/upstream.source.tsconfig.json', plugins: [nativeChangesPlatform], logLevel: 'error',
    });
    const host = await import(pathToFileURL(bundle).href) as typeof import('./fixtures/workspace-changes-host.ts');
    const projects = join(scratch, 'projects');
    await mkdir(projects);
    const sibling = join(projects, 'other-project');
    await mkdir(sibling);
    await writeFile(join(sibling, 'a.txt'), 'other project bytes\n');
    const cwd = join(projects, 'repo');
    git(scratch, 'init', '-q', '-b', 'main', cwd);
    await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n');
    await writeFile(join(cwd, '.gitignore'), '.env\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'init');
    const before = new Set(await readdir('/tmp'));

    const {ctx, spawned, session: create} = await host.boot();
    const session = create('changes', cwd);
    host.startTurn(session, 1);
    await host.settle(ctx, session);
    await host.mutate(ctx, session, 1, 'edit', {file_path: 'a.txt'}, 'a.txt', () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\nl4\n'));
    await host.mutate(ctx, session, 1, 'write', {file_path: '.env'}, '.env', () => writeFile(join(cwd, '.env'), 'A=1\n'));
    await writeFile(join(cwd, 'new.txt'), 'n1\nn2\n');
    await writeFile(join(sibling, 'a.txt'), 'unrelated sibling edit\n');
    host.endTurn(session, 1);
    await host.settle(ctx, session);

    const [summary, ...rest] = host.changes(ctx, session);
    assert.deepEqual(rest, []);
    assert.deepEqual(summary?.files, [
      {path: '.env', display: '.env', added: 1, deleted: 0},
      {path: 'a.txt', display: 'a.txt', added: 2, deleted: 1},
      {path: 'new.txt', display: 'new.txt', added: 2, deleted: 0},
    ]);
    const seq = session.snapshotEvents().find(event => event.type === 'workspace/changes')!.seq;
    // The ignored file's comparison reads both captures back from the container.
    const ignored = await ctx.workspaceChanges.diff(session.id, seq, 0, new AbortController().signal);
    assert.ok(ignored && 'hunks' in ignored && JSON.stringify(ignored.hunks).includes('+A=1'), JSON.stringify(ignored));
    const tracked = await ctx.workspaceChanges.diff(session.id, seq, 1, new AbortController().signal);
    assert.ok(tracked && 'hunks' in tracked && JSON.stringify(tracked.hunks).includes('+l2 model'), JSON.stringify(tracked));
    // Every command ran as git or a container shell script; the scratch directory was the container's /tmp.
    assert.ok(spawned.includes('/weft/container/sh') && spawned.includes('/usr/bin/git'));
    const created = (await readdir('/tmp')).filter(name => !before.has(name) && name.startsWith('dsh-workspace-changes-'));
    assert.equal(created.length, 1);
    await ctx.fiber.dispose();
    // Disposal removes the scratch directory with one more container command after the recorder's queued work settles.
    const deadline = Date.now() + 10_000;
    while ((await readdir('/tmp')).some(name => created.includes(name)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await readdir('/tmp')).filter(name => created.includes(name)).length, 0, 'disposal removes the scratch directory in the container');
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
});
