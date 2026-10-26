import assert from 'node:assert/strict';
import {readFileSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(import.meta.dirname, '..');
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

export function releaseIdentity(version) {
  assert.equal(typeof version, 'string');
  assert.equal(version, version.trim(), 'Version must not contain surrounding whitespace');
  // Canonical SemVer; no build metadata because tags are immutable release identities.
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/);
  return {tag: `v${version}`, prerelease: version.includes('-')};
}

export function assertProjectCI(run, jobs, {repository, sha, dsh}) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(run.head_sha, sha, 'CI must validate this exact main commit');
  assert.equal(run.head_repository?.full_name, repository, 'CI must belong to this repository');
  assert.equal(run.path, '.github/workflows/test.yml');
  assert.equal(run.head_branch, 'ci');
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  const required = [
    'build', 'Plugin package builder', 'Container processes and FUSE',
    ...[1, 2, 3, 4].map(shard => `Unit ${shard}/4`),
    ...[1, 2].map(shard => `Browser ${shard}/2`),
    ...dsh.split(' || ').map(version => `Published local DSH (${version})`),
  ];
  assert.ok(jobs.length && jobs.every(job => job.conclusion === 'success'), 'Every CI job must succeed; skipped jobs are refused');
  for (const name of required) assert.ok(jobs.some(job => job.name === name), `Missing required CI job: ${name}`);
}

async function main() {
  const {GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF: ref, GH_TOKEN: token} = process.env;
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.equal(ref, 'refs/heads/main', 'Dispatch the release workflow on main');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  assert.ok(token, 'A scoped GitHub Actions token is required');
  const metadata = readJson('package.json'), lock = readJson('package-lock.json');
  assert.equal(process.env.RELEASE_VERSION, metadata.version, 'Requested version must match package.json');
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[''].version, metadata.version);
  const {tag, prerelease} = releaseIdentity(metadata.version);
  const notes = readFileSync(resolve(root, `docs/releases/${tag}.md`), 'utf8');
  assert.ok(notes.trim(), 'Committed release notes are required');

  const api = async (path, method = 'GET', body, optional = false) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method, headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (optional && response.status === 404) return undefined;
    assert.ok(response.ok, `GitHub ${method} ${path.split('?')[0]} failed: HTTP ${response.status}`);
    return response.json();
  };
  const ciId = process.env.RELEASE_CI_RUN;
  let run;
  if (ciId) {
    assert.match(ciId, /^\d+$/);
    run = await api(`actions/runs/${ciId}`);
  } else {
    const result = await api(`actions/workflows/test.yml/runs?head_sha=${sha}&branch=ci&event=push&status=success&per_page=100`);
    run = result.workflow_runs.find(item => item.head_sha === sha);
  }
  assert.ok(run, 'Run Test on ci for this exact commit before releasing');
  const jobs = [];
  for (let page = 1;; page++) {
    const batch = await api(`actions/runs/${run.id}/jobs?per_page=100&page=${page}`);
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) break;
  }
  assertProjectCI(run, jobs, {repository, sha, dsh: readJson('packages/local-host-connector/package.json').engines.dsh});

  // Check existing tags by resolving annotated objects, never move a published tag.
  const existingTag = await api(`git/ref/tags/${tag}`, 'GET', undefined, true);
  if (existingTag) {
    let object = existingTag.object;
    for (let depth = 0; object.type === 'tag'; depth++) {
      assert.ok(depth < 5, 'Unexpected annotated tag depth');
      object = (await api(`git/tags/${object.sha}`)).object;
    }
    assert.equal(object.type, 'commit');
    assert.equal(object.sha, sha, 'Release tag already points to a different commit');
  }
  const command = process.argv[2];
  if (command === 'verify') {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nci_run=${run.id}\n`);
    console.log(`Verified ${tag} at ${sha}, Test run ${run.id}`);
    return;
  }
  assert.equal(command, 'publish');
  if (!existingTag) {
    const annotation = await api('git/tags', 'POST', {tag, message: `Weft ${metadata.version}\n\nValidated by Test run ${run.id}.`, object: sha, type: 'commit'});
    await api('git/refs', 'POST', {ref: `refs/tags/${tag}`, sha: annotation.sha});
  }
  const existingRelease = await api(`releases/tags/${tag}`, 'GET', undefined, true);
  if (existingRelease) {
    assert.equal(existingRelease.draft, false, 'An existing draft must be reviewed before publication');
    console.log(`Release already exists: ${existingRelease.html_url}`);
    return;
  }
  const release = await api('releases', 'POST', {
    tag_name: tag, target_commitish: sha, name: `Weft ${metadata.version}`, draft: false,
    prerelease, make_latest: prerelease ? 'false' : 'true',
    body: notes.trim() + `\n\n[Verified CI run](https://github.com/${repository}/actions/runs/${run.id}) · Commit: \`${sha}\`\n`,
  });
  console.log(`Published ${release.html_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
