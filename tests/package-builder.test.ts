import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture, archiveFiles} from './helpers/package-fixture.ts';

test('offline builder compiles ESM packages, shares browser React and refuses unsupported imports and escaped files', async () => {
  const fixture = packageFixture();
  const artifact = await buildPackage(fixture.input);
  assert.match(artifact.host!, /export default async/); assert.match(artifact.client!, /__weft_sdk\.React/);
  assert.deepEqual(artifact.lock, fixture.input.lock);
  assert.deepEqual(artifact.permissions, fixture.input.declaration.permissions);
  for (const source of ['import fs from "node:fs";export default ()=>fs', 'import value from "/etc/passwd";export default ()=>value', 'import native from "missing-native-addon";export default ()=>native']) {
    const bad = packageFixture({files: {'host.js': source}});
    await assert.rejects(buildPackage(bad.input));
  }
  const tampered = structuredClone(fixture.input); tampered.packages[0]!.bytes = archiveFiles({'../escape': 'bad'}).toString('base64');
  await assert.rejects(buildPackage(tampered), /path|integrity/i);
  const mismatch = structuredClone(fixture.input); mismatch.lock[0]!.integrity = 'sha512-invalid';
  await assert.rejects(buildPackage(mismatch), /integrity/);
});

test('the production builder image compiles without a network or workspace mount', {skip: !process.env.WEFT_BUILDER_IMAGE}, async () => {
  const fixture = packageFixture();
  const child = spawn('docker', ['run', '--rm', '--network', 'none', '-i', '--entrypoint', 'node', process.env.WEFT_BUILDER_IMAGE!, '--input-type=module', '-e', 'import {buildPackage} from "/opt/weft-builder/server.mjs";let input="";for await(const block of process.stdin)input+=block;console.log(JSON.stringify(await buildPackage(JSON.parse(input))));'], {stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', error = ''; child.stdout.on('data', value => {output += value;}); child.stderr.on('data', value => {error += value;});
  child.stdin.end(JSON.stringify(fixture.input));
  const code = await new Promise<number | null>((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);});
  assert.equal(code, 0, error);
  const artifact = JSON.parse(output); assert.match(artifact.host, /export default/); assert.match(artifact.client, /React/);
});
