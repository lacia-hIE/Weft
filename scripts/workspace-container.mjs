import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The workspace container image: built from apps/workspace-container and
 * pushed to the account's Cloudflare registry under a tag derived from the
 * Dockerfile, so the deployed configuration names exactly the image it was
 * reviewed with. `--check` (run by the build) fails when the Dockerfile
 * changed without a push, or when its computerd does not match the
 * @cloudflare/computer package the Worker bundles.
 *
 *   node scripts/workspace-container.mjs          build, push and record the image
 *   node scripts/workspace-container.mjs --check  verify the recorded image
 */
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'apps/workspace-container');
const dockerfile = readFileSync(resolve(directory, 'Dockerfile'), 'utf8');
const record = resolve(directory, 'image.json');
const NAME = 'weft-workspace-shell';

const computer = JSON.parse(readFileSync(resolve(root, 'node_modules/@cloudflare/computer/package.json'), 'utf8')).version;
const computerd = /^FROM ghcr\.io\/cloudflare\/computer-computerd-linux-x64:(\S+) AS computerd$/m.exec(dockerfile)?.[1];
if (computerd !== computer) throw new Error(`The workspace container's computerd (${computerd}) must match @cloudflare/computer ${computer}`);
const tag = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);

if (process.argv.includes('--check')) {
  const {reference} = JSON.parse(readFileSync(record, 'utf8'));
  if (!reference.endsWith(`/${NAME}:${tag}`)) throw new Error(`apps/workspace-container/image.json names ${reference}, not the current Dockerfile (${tag}); run node scripts/workspace-container.mjs`);
} else {
  execFileSync('docker', ['build', '--platform', 'linux/amd64', '-t', `${NAME}:${tag}`, directory], {stdio: 'inherit'});
  const output = execFileSync(process.execPath, [resolve(root, 'node_modules/cf/bin/cf'), 'containers', 'push', '--tag', `${NAME}:${tag}`], {cwd: root, encoding: 'utf8'});
  process.stdout.write(output);
  const reference = /registry\.cloudflare\.com\/\S+?\/weft-workspace-shell:[0-9a-f]{12}/.exec(output)?.[0];
  if (!reference) throw new Error('The registry push did not report the image reference');
  writeFileSync(record, JSON.stringify({reference}, null, 2) + '\n');
  console.log(`Recorded ${reference}`);
}
