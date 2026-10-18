import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {imageFixtures, paddedPng} from '../tests/helpers/images.ts';

// Local cf dev + remote Images; this entrypoint is never deployed or publicly routed.
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.generated/native-image-validation');
await mkdir(directory, {recursive: true});
await readFile(resolve(root, 'dist/images-worker.js')); // Requires the current application build.
const dependencies = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).devDependencies;
await writeFile(resolve(directory, 'package.json'), JSON.stringify({name: 'weft-native-image-validation', private: true, type: 'module', devDependencies: {wrangler: dependencies.wrangler}}));
try {await symlink(resolve(root, 'node_modules'), resolve(directory, 'node_modules'), 'dir');} catch (error) {if (error.code !== 'EEXIST') throw error;}
await writeFile(resolve(directory, 'cloudflare.config.ts'), `import {bindings,defineConfig,exports} from 'cf/config';
export default defineConfig({worker:{name:'weft-native-image-validation',entrypoint:'../../dist/images-worker.js',compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat','enable_request_signal'],workersDev:false,previewUrls:false,env:{IMAGES:bindings.images({dev:{remote:true}}),WORKSPACES:bindings.durableObject({worker:'weft-native-image-validation',exportName:'WorkspaceDO'})},exports:{WorkspaceDO:exports.durableObject({storage:'sqlite'})}}});
`);
const log = await open(resolve(root, '.generated/native-images-remote-dev.log'), 'w');
const server = spawn(resolve(root, 'node_modules/.bin/cf'), ['dev', '--port', '8799'], {cwd: directory, env: {...process.env, CF_SEND_TELEMETRY: 'false', WRANGLER_SEND_METRICS: 'false'}, stdio: ['ignore', log.fd, log.fd]});
const stopped = new Promise(resolve => server.once('exit', resolve));
const environment = 'verify-' + crypto.randomUUID().slice(0, 8);
const endpoint = 'http://127.0.0.1:8799/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(mode, input, options = {}) {
  const query = new URLSearchParams({mode, environment, ...options});
  const binary = input instanceof Uint8Array;
  // Fixture generation can outlast cf dev's keep-alive idle timeout. Use an
  // explicit connection per local probe instead of retrying failed operations.
  const response = await fetch(endpoint + '?' + query, {method: 'POST', headers: {connection: 'close'}, body: binary ? input : JSON.stringify(input), signal: AbortSignal.timeout(60000)});
  const value = await response.json();
  return {status: response.status, value};
}
const results = [];
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('cf image validation server exited; inspect .generated/native-images-remote-dev.log');
    try {if ((await fetch(endpoint, {signal: AbortSignal.timeout(1000)})).ok) break;} catch {}
    if (Date.now() >= deadline) throw new Error('Timed out starting the cf image validation server');
    await sleep(250);
  }
  const fixture = await imageFixtures();
  for (const [name, type] of [['png', 'png'], ['jpeg', 'jpeg'], ['webp', 'webp'], ['gif', 'gif'], ['oriented', 'jpeg'], ['profiled', 'png'], ['sixteenBit', 'png']]) {
    const {status, value} = await call('normalize', fixture[name], {type: 'image/' + type, name: '../private\\source.' + type});
    assert.equal(status, 200, JSON.stringify(value));
    const bytes = Buffer.from(value.data, 'base64');
    const info = await sharp(bytes).metadata();
    assert.equal(info.format, 'webp'); assert.equal(info.depth, 'uchar'); assert.equal(info.space, 'srgb'); assert.equal(info.pages ?? 1, 1); assert.equal(info.icc, undefined); assert.equal(info.exif, undefined);
    assert.equal(value.ref.attachmentId, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
    const dimensions = name === 'oriented' ? [32, 64] : name === 'gif' ? [1, 1] : [64, 32];
    assert.deepEqual([value.ref.width, value.ref.height], dimensions);
    if (['png', 'webp', 'profiled', 'sixteenBit'].includes(name)) assert.equal(info.hasAlpha, true);
    const actualPixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
    const expectedPixels = await sharp(fixture[name]).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer();
    const actualPixel = [...actualPixels.subarray(0, 4)];
    const expectedPixel = [...expectedPixels.subarray(0, 4)];
    assert.ok(actualPixel.every((channel, index) => Math.abs(channel - expectedPixel[index]) <= (index === 3 ? 1 : 8)), `${name}: actual pixels ${actualPixel} differ from sRGB source ${expectedPixel}`);
    if (name === 'oriented') {
      const corners = [[0, 0], [31, 0], [0, 63], [31, 63]];
      for (const [x, y] of corners) {
        const offset = (y * 32 + x) * 4;
        const actual = [...actualPixels.subarray(offset, offset + 4)], expected = [...expectedPixels.subarray(offset, offset + 4)];
        assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8), `EXIF corner (${x},${y}): actual ${actual} differs from rotated source ${expected}`);
      }
      results.push({case: 'orientedCornerPixels', matchedCorners: 4});
    }
    assert.match(value.path, /^\/workspace\/\.weft\/attachments\/v1\/files\//);
    results.push({case: name, width: info.width, height: info.height, depth: info.depth, space: info.space, hasAlpha: info.hasAlpha, actualPixel, expectedPixel});
  }
  for (const data of [fixture.png.subarray(0, 33), fixture.png.subarray(0, Math.floor(fixture.png.length / 2))]) {
    const result = await call('normalize', data, {type: 'image/png'});
    assert.equal(result.status, 400); assert.equal(result.value.code, 'INVALID_IMAGE');
  }
  results.push({case: 'truncatedInputs', rejected: 2});
  const wide = await sharp({create: {width: 8193, height: 1, channels: 3, background: 'red'}}).png().toBuffer();
  const dimension = await call('normalize', wide, {type: 'image/png'});
  assert.equal(dimension.value.code, 'IMAGE_DIMENSION_TOO_LARGE');
  const large = await sharp({create: {width: 3000, height: 2000, channels: 4, background: {r: 255, g: 0, b: 0, alpha: 0.5}}}).png().toBuffer();
  const normalized = await call('normalize', large, {type: 'image/png'});
  assert.equal(normalized.status, 200, JSON.stringify(normalized.value));
  assert.deepEqual(normalized.value.ref.originalDimensions, {width: 3000, height: 2000});
  assert.ok(normalized.value.ref.width * normalized.value.ref.height <= 2048 * 2048);
  const target = {width: 32, height: 21, maxBytes: 100000};
  const projected = await call('project', {ref: normalized.value.ref, target});
  assert.equal(projected.status, 200, JSON.stringify(projected.value));
  assert.deepEqual([projected.value.width, projected.value.height], [32, 21]);
  assert.equal(projected.value.hasAlpha, true);
  const cached = await call('project', {ref: normalized.value.ref, target}, {codec: 'off'});
  assert.equal(cached.status, 200, JSON.stringify(cached.value));
  assert.equal(cached.value.codecCalls, 0);
  assert.deepEqual(cached.value, {...projected.value, codecCalls: 0});
  results.push({case: 'normalizedGeometryAndColdCache', source: normalized.value.ref.originalDimensions, normalized: [normalized.value.ref.width, normalized.value.ref.height], request: [projected.value.width, projected.value.height], coldCodecCalls: cached.value.codecCalls});
  const constrained = await call('project', {ref: normalized.value.ref, target: {...target, maxBytes: 1}});
  assert.equal(constrained.status, 200, JSON.stringify(constrained.value));
  assert.notEqual(constrained.value.variantId, projected.value.variantId);
  assert.equal(constrained.value.codecCalls, 6, 'all three qualities each invoke the encoder and output inspection');
  assert.ok(constrained.value.bytes > 1, 'the native byte target is soft, preserving a valid image');
  assert.ok(constrained.value.bytes <= projected.value.bytes);
  const cachedConstrained = await call('project', {ref: normalized.value.ref, target: {...target, maxBytes: 1}}, {codec: 'off'});
  assert.deepEqual(cachedConstrained.value, {...constrained.value, codecCalls: 0});
  results.push({case: 'requestQualityLadder', bytes: constrained.value.bytes, codecCalls: constrained.value.codecCalls, coldCodecCalls: cachedConstrained.value.codecCalls});
  const maxSource = paddedPng(fixture.png, 20_000_000);
  const maximum = await call('normalize', maxSource, {type: 'image/png'});
  assert.equal(maximum.status, 200, JSON.stringify(maximum.value));
  results.push({case: 'maximumSourceBytes', bytes: maxSource.length});
  const oversized = await call('normalize', paddedPng(fixture.png, 20_000_001), {type: 'image/png'});
  assert.equal(oversized.value.code, 'IMAGE_TOO_LARGE');
  await call('corrupt', {ref: normalized.value.ref});
  const corrupt = await call('read', {ref: normalized.value.ref}, {codec: 'off'});
  assert.equal(corrupt.status, 400); assert.ok(['ATTACHMENT_CORRUPT', 'ATTACHMENT_READ_FAILED'].includes(corrupt.value.code));
  results.push({case: 'corruption', code: corrupt.value.code});
  const devLog = (await readFile(resolve(root, '.generated/native-images-remote-dev.log'), 'utf8')).replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(devLog, /env\.IMAGES\s+Images\s+remote/);
  const report = {remoteBinding: true, workerBundleSha256: createHash('sha256').update(await readFile(resolve(root, 'dist/images-worker.js'))).digest('hex'), cases: results};
  await writeFile(resolve(root, '.generated/native-images-remote-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  server.kill('SIGINT');
  await Promise.race([stopped, sleep(5000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await log.close();
}
