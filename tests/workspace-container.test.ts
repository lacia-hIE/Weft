import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { CONTAINER_LOCAL_PATHS, CONTAINER_MOUNT_IGNORE } from '../packages/workspace/src/container-policy.ts';
import { shellOutputFrames } from '../packages/workspace/src/exec-output.ts';

async function frames(container: boolean, events: {name: string; value?: unknown; code?: unknown}[]) {
  let released = false;
  const source = new ReadableStream({start(controller) {for (const event of events) controller.enqueue(event); controller.close();}});
  const text = await new Response(source.pipeThrough(shellOutputFrames(container, () => {released = true;}))).text();
  assert.ok(released, 'the execution releases its activity lease');
  return text.trim().split('\n').map(line => JSON.parse(line) as {type: string; data?: string; code?: number});
}

test('a failed container write reports the FUSE limit and Git recovery choices, preserving output and exit status', async () => {
  const output = await frames(true, [
    {name: 'stdout', value: 'Receiving objects'},
    {name: 'stderr', value: 'fatal: write error: Fi'},
    {name: 'stderr', value: 'le too large\n'},
    {name: 'exit', code: 128},
  ]);
  assert.deepEqual(output.slice(0, 3), [
    {type: 'stdout', data: 'Receiving objects'}, {type: 'stderr', data: 'fatal: write error: Fi'}, {type: 'stderr', data: 'le too large\n'},
  ]);
  assert.match(output[3]!.data!, /256 MiB[\s\S]*--depth 1[\s\S]*unpushed commits/);
  assert.deepEqual(output[4], {type: 'exit', code: 128});
  const efbig = await frames(true, [{name: 'stderr', value: 'x'.repeat(20_000) + '\nEFBIG'}, {name: 'exit', value: 1}]);
  assert.match(efbig[1]!.data!, /computerd/);
  assert.deepEqual(efbig[2], {type: 'exit', code: 1});
});

test('successful commands, unrelated failures and Worker errors keep their original output', async () => {
  for (const [container, stderr, code] of [[true, 'File too large', 0], [true, 'Authentication failed', 128], [false, 'EFBIG', 1]] as const) {
    assert.deepEqual(await frames(container, [{name: 'stderr', value: stderr}, {name: 'exit', code}]), [{type: 'stderr', data: stderr}, {type: 'exit', code}]);
  }
});

const runFile = promisify(execFile);

/** Opt-in: actual pinned computerd/FUSE, a >256 MiB incoming Git pack, and the production ignore policy. */
test('computerd keeps dependency trees local and supports shallow clone when a full Git pack exceeds its file limit', {
  skip: process.env.WEFT_CONTAINER_TESTS !== '1', timeout: 300_000,
}, async () => {
  const image = process.env.WEFT_CONTAINER_IMAGE ?? (JSON.parse(readFileSync('apps/workspace-container/image.json', 'utf8')) as {reference: string}).reference;
  const name = `weft-git-test-${crypto.randomUUID()}`;
  const docker = (...args: string[]) => runFile('docker', args, {timeout: 240_000, maxBuffer: 2 * 1024 * 1024});
  try {
    await docker('run', '--detach', '--name', name, '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
      '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined',
      '--env', 'RPC_CLIENT_SECRET=weft-container-test', '--env', `MOUNT_IGNORE=${CONTAINER_MOUNT_IGNORE}`, '--env', 'MOUNT_IGNORE_PATH=/var/tmp/weft-local',
      '--env', 'COMPUTERD_DB=/var/lib/computerd/state.db', image);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {await docker('exec', name, 'mountpoint', '-q', '/workspace'); break;}
      catch (error) {if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 200));}
    }
    const {stdout} = await docker('exec', name, 'python3', '-c', `
import json, os, pathlib, sqlite3, subprocess
root = pathlib.Path('/workspace/cache-probe')
root.mkdir()
(root / 'source.txt').write_text('durable source')
(root / '.git').mkdir()
(root / '.git/config').write_text('durable git metadata')
paths = json.loads(${JSON.stringify(JSON.stringify(CONTAINER_LOCAL_PATHS.map(pattern => pattern.slice(3))))})
for path in paths:
    target = root / path / 'marker.txt'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('rebuildable')
    assert pathlib.Path('/var/tmp/weft-local/cache-probe', path, 'marker.txt').read_text() == 'rebuildable'
db = sqlite3.connect('file:/var/lib/computerd/state.db?mode=ro', uri=True)
names = {row[0] for row in db.execute('SELECT name FROM vfs_dirents')}
assert 'source.txt' in names and '.git' in names and 'config' in names, names
assert 'marker.txt' not in names, names
assert not pathlib.Path('/var/tmp/weft-local/cache-probe/.git/config').exists()
# The same large size is refused on the synced mount and accepted in a local-only tree.
large = root / 'large.bin'
failed = subprocess.run(['truncate', '-s', '268435457', str(large)], capture_output=True, text=True)
assert failed.returncode != 0 and 'File too large' in failed.stderr, failed
large.unlink(missing_ok=True)
local_large = root / 'node_modules/large.bin'
subprocess.run(['truncate', '-s', '268435457', str(local_large)], check=True)
assert local_large.stat().st_size == 268435457
local_large.unlink()
# Historical binary versions make the full clone pack exceed the cap; the current source is small.
repo = pathlib.Path('/var/tmp/origin')
def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True)
git('init', '-q', '-b', 'main', str(repo))
git('-C', str(repo), 'config', 'user.name', 'Fixture')
git('-C', str(repo), 'config', 'user.email', 'fixture@example.test')
for revision in range(3):
    with (repo / 'source.bin').open('wb') as file:
        for chunk in range(96): file.write(os.urandom(1024 * 1024))
    git('-C', str(repo), 'add', 'source.bin')
    git('-C', str(repo), 'commit', '-q', '-m', 'historical binary ' + str(revision))
(repo / 'source.bin').write_text('current source')
git('-C', str(repo), 'commit', '-qam', 'replace historical binary')
full = subprocess.run(['git', 'clone', '-q', '--no-local', str(repo), '/workspace/full'], capture_output=True, text=True)
assert full.returncode != 0 and 'File too large' in full.stderr, full
git('clone', '-q', '--no-local', '--depth', '1', '--single-branch', '--no-tags', str(repo), '/workspace/shallow')
assert pathlib.Path('/workspace/shallow/source.bin').read_text() == 'current source'
assert git('-C', '/workspace/shallow', 'rev-parse', '--is-shallow-repository').stdout.strip() == 'true'
assert git('-C', '/workspace/shallow', 'status', '--porcelain').stdout == ''
print(json.dumps({'localTrees': len(paths), 'sourceAndGitStored': True, 'fullCloneFailed': True, 'shallowClonePassed': True, 'stderr': full.stderr}))
`);
    const result = JSON.parse(stdout) as {localTrees: number; sourceAndGitStored: boolean; fullCloneFailed: boolean; shallowClonePassed: boolean; stderr: string};
    assert.equal(result.localTrees, CONTAINER_LOCAL_PATHS.length);
    assert.equal(result.sourceAndGitStored && result.fullCloneFailed && result.shallowClonePassed, true);
    const output = await frames(true, [{name: 'stderr', value: result.stderr}, {name: 'exit', code: 128}]);
    assert.match(output[1]!.data!, /256 MiB/);
  } finally {
    await docker('rm', '--force', name).catch(() => undefined);
  }
});
