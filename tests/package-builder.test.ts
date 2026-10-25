import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture, styledPackageFixture, archiveFiles} from './helpers/package-fixture.ts';
import {artifactSchema} from '../packages/package-install/src/contracts.ts';

test('offline builder compiles ESM packages, shares browser React and refuses unsupported imports and escaped files', async () => {
  const fixture = packageFixture();
  const artifact = await buildPackage(fixture.input);
  assert.match(artifact.host!, /export default async/); assert.match(artifact.client!, /__runtime\.React/);
  assert.deepEqual(artifact.lock, fixture.input.lock);
  assert.equal(artifact.rows[0]?.config && (artifact.rows[0].config as {value: string}).value, 'from-patch');
  assert.equal(artifact.permissions.client, true);
  for (const source of ['import fs from "node:fs";export default ()=>fs', 'import value from "/etc/passwd";export default ()=>value', 'import native from "missing-native-addon";export default ()=>native']) {
    const bad = packageFixture({files: {'host.js': source}});
    await assert.rejects(buildPackage(bad.input));
  }
  const expression = packageFixture({files: {'cordis.patch.yml': '- insert: !!js process.exit()'}});
  await assert.rejects(buildPackage(expression.input));
  const outside = packageFixture({patch: [{id: 'tool-bash', disabled: true}]});
  await assert.rejects(buildPackage(outside.input), /unavailable entry/);
  const untrusted = packageFixture({files: {'package.json': JSON.stringify({name: fixture.name, version: fixture.version, weft: {plugin: {}}})}});
  await assert.rejects(buildPackage(untrusted.input), /declaration/);
  const tampered = structuredClone(fixture.input); tampered.packages[0]!.bytes = archiveFiles({'../escape': 'bad'}).toString('base64');
  await assert.rejects(buildPackage(tampered), /path|integrity/i);
  const mismatch = structuredClone(fixture.input); mismatch.lock[0]!.integrity = 'sha512-invalid';
  await assert.rejects(buildPackage(mismatch), /integrity/);
});

test('the production builder image compiles without a network or workspace mount', {skip: !process.env.WEFT_BUILDER_IMAGE}, async () => {
  const fixture = styledPackageFixture();
  const child = spawn('docker', ['run', '--rm', '--network', 'none', '-i', '--entrypoint', 'node', process.env.WEFT_BUILDER_IMAGE!, '--input-type=module', '-e', 'import {buildPackage} from "/opt/weft-builder/server.mjs";let input="";for await(const block of process.stdin)input+=block;console.log(JSON.stringify(await buildPackage(JSON.parse(input))));'], {stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', error = ''; child.stdout.on('data', value => {output += value;}); child.stderr.on('data', value => {error += value;});
  child.stdin.end(JSON.stringify(fixture.input));
  const code = await new Promise<number | null>((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);});
  assert.equal(code, 0, error);
  const artifact = JSON.parse(output); assert.match(artifact.host, /export default/); assert.match(artifact.client, /React/);
  assert.match(artifact.css, /color:/); assert.equal(Object.keys(artifact.assets).length,1);
});

test('Client CSS Modules, inline CSS, native controls and static URLs are part of the exact artifact', async () => {
  const artifact=artifactSchema.parse(await buildPackage(styledPackageFixture().input));
  assert.match(artifact.css!, /color:#123|color:rgb\(17,34,51\)/);
  assert.match(artifact.css!, /url\(\.\/assets\//);
  assert.equal(Object.keys(artifact.assets!).length,1,'CSS, inline CSS and JS deduplicate the same asset');
  assert.match(artifact.client!, /__runtime\.asset\(/);
  assert.match(artifact.client!, /__runtime\.css\(/);
  assert.match(artifact.client!, /stylesheet=true/);
  const svg=Buffer.from(Object.values(artifact.assets!)[0]!,'base64').toString();assert.match(svg,/<svg/);
  await assert.rejects(buildPackage(packageFixture({files:{'host.js':"import './host.css';export function apply(){}",'host.css':'.host{color:red}'}}).input),/Client entry/);
  await assert.rejects(buildPackage(packageFixture({files:{'client.js':"import './remote.css';export function apply(){}",'remote.css':'@import "https://untrusted.test/remote.css";'}}).input),/Unsupported import/);
  await assert.rejects(buildPackage(packageFixture({files:{'client.js':"import large from './large.svg';export function apply(){return large}",'large.svg':'<svg><!--'+'x'.repeat(1048576)+'--></svg>'}}).input),/asset exceeds/);
  assert.equal(artifactSchema.safeParse({...artifact,assets:{'../escape.svg':'eA=='}}).success,false);
});
