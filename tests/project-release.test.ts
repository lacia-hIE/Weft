import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {workspaceDependencyLock} from '../scripts/workspace-image-input.mjs';
import {assertProjectCI, releaseIdentity} from '../scripts/project-release.mjs';

test('project tags accept canonical stable and prerelease versions without ambiguous identities', () => {
  assert.deepEqual(releaseIdentity('0.1.0'), {tag: 'v0.1.0', prerelease: false});
  assert.deepEqual(releaseIdentity('1.2.0-rc.2'), {tag: 'v1.2.0-rc.2', prerelease: true});
  for (const value of ['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '1.0.0-', '1.0.0+build', '../tag', '1.0.0\n', undefined]) {
    assert.throws(() => releaseIdentity(value));
  }
});

test('releases reject foreign, incomplete or stale CI even when the run reports success', () => {
  const sha = 'a'.repeat(40), repository = 'example/Weft';
  const expected = {sha, repository, dsh: '0.2.1-rc.2 || 0.2.1-rc.3'};
  const run = {head_sha: sha, head_repository: {full_name: repository}, path: '.github/workflows/test.yml', head_branch: 'ci', event: 'push', status: 'completed', conclusion: 'success'};
  const jobs = ['build', 'Plugin package builder', 'Container processes and FUSE', ...[1,2,3,4].map(i => `Unit ${i}/4`), ...[1,2].map(i => `Browser ${i}/2`), 'Published local DSH (0.2.1-rc.2)', 'Published local DSH (0.2.1-rc.3)'].map(name => ({name, conclusion: 'success'}));
  assertProjectCI(run, jobs, expected);
  for (const changed of [{head_sha: 'b'.repeat(40)}, {head_repository: {full_name: 'other/Weft'}}, {head_branch: 'main'}, {event: 'pull_request'}, {status: 'in_progress'}, {conclusion: 'failure'}, {path: '.github/workflows/release.yml'}]) {
    assert.throws(() => assertProjectCI({...run, ...changed}, jobs, expected));
  }
  for (const job of jobs) assert.throws(() => assertProjectCI(run, jobs.filter(item => item !== job), expected));
  assert.throws(() => assertProjectCI(run, [...jobs, {name: 'new check', conclusion: 'skipped'}], expected));
  assert.throws(() => assertProjectCI(run, jobs.map((job, i) => i === 0 ? {...job, conclusion: 'failure'} : job), expected));
});


test('project release dispatch separates the read-only gate from publication and never grants npm identity', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    on: Record<string, unknown>; permissions: Record<string, string>;
    jobs: Record<string, {if: string; needs?: string; permissions: Record<string, string>; steps: {run?: string; with?: Record<string, unknown>}[]}>;
  };
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  const verify = workflow.jobs.verify!, publish = workflow.jobs.publish!;
  assert.equal(publish.needs, 'verify');
  assert.equal(verify.permissions.contents, 'read');
  assert.equal(publish.permissions.contents, 'write');
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
    assert.equal(job.permissions.actions, 'read');
    assert.equal(job.permissions['id-token'], undefined);
    assert.ok(job.steps.some(step => step.with?.['persist-credentials'] === false));
  }
  assert.ok(verify.steps.some(step => step.run === 'node scripts/project-release.mjs verify'));
  assert.ok(publish.steps.some(step => step.run === 'node scripts/project-release.mjs publish'));
});


test('application version changes retain image identity while dependency and integrity changes invalidate it', () => {
  const baseline = {name: 'weft', version: '0.0.1', lockfileVersion: 3, packages: {'': {name: 'weft', version: '0.0.1', engines: {node: '>=22.19.0'}}, 'node_modules/example': {version: '1.2.3', integrity: 'sha512-reviewed'}}};
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const canonical = bytes(baseline).toString();
  assert.equal(workspaceDependencyLock(new Uint8Array(bytes(baseline))), canonical);
  const release = structuredClone(baseline);
  release.version = release.packages[''].version = '0.1.0';
  assert.equal(workspaceDependencyLock(bytes(release)), canonical);
  const changed = structuredClone(release);
  changed.packages['node_modules/example'].version = '1.2.4';
  assert.notEqual(workspaceDependencyLock(bytes(changed)), canonical);
  changed.packages['node_modules/example'].version = '1.2.3';
  changed.packages['node_modules/example'].integrity = 'sha512-different';
  assert.notEqual(workspaceDependencyLock(bytes(changed)), canonical);
  const engines = structuredClone(release);
  engines.packages[''].engines.node = '>=24.0.0';
  assert.notEqual(workspaceDependencyLock(bytes(engines)), canonical);
});
