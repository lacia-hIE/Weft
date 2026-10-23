import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..'), directory = resolve(root, 'apps/plugin-builder');
const hash = createHash('sha256');
for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'server.mjs']) hash.update(name).update(readFileSync(resolve(directory, name)));
for (const path of ['upstream.lock.json', 'scripts/prepare-upstream.mjs']) hash.update(path).update(readFileSync(resolve(root, path)));
const tag = hash.digest('hex').slice(0, 12), image = `weft-plugin-builder:${tag}`;
if (process.argv.includes('--tag')) {console.log(image); process.exit(0);}
if (process.argv.includes('--local')) {execFileSync('docker', ['build', '--platform', 'linux/amd64', '-t', image, directory], {stdio: 'inherit'}); process.exit(0);}
if (process.argv.includes('--publish')) {
  // Images are built and tested in CI, then loaded from its artifact. Never build implicitly during publication.
  execFileSync('docker', ['image', 'inspect', image], {stdio: 'ignore'});
  const output = execFileSync(process.execPath, [resolve(root, 'node_modules/cf/bin/cf'), 'containers', 'push', '--tag', image], {cwd: root, encoding: 'utf8'});
  const reference = /registry\.cloudflare\.com\/\S+?\/weft-plugin-builder:[0-9a-f]{12}/.exec(output)?.[0];
  if (!reference) throw new Error('Container registry did not return the pushed image');
  writeFileSync(resolve(directory, 'image.json'), JSON.stringify({reference}, null, 2) + '\n');
  console.log(`Published ${reference}`); process.exit(0);
}
const {reference} = JSON.parse(readFileSync(resolve(directory, 'image.json'), 'utf8'));
if (!reference.endsWith('/' + image)) throw new Error('Plugin builder image is stale; build the current image in CI and publish it');
