import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officialPlatformModules, officialUiRoster } from './official-ui-roster.mjs';

const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(readFileSync(resolve(root, '.generated/upstream-source.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, '.generated/official-ui/build-report.json'), 'utf8'));
if (report.upstream !== source.commit || report.failures.length) throw new Error('Official client build is missing or stale');
const output = resolve(root, '.generated/official-web-assets');
rmSync(output, {recursive: true, force: true});
mkdirSync(output, {recursive: true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const roster = officialUiRoster(source.directory, {profile: 'web'});
const rows = new Map(roster.map(row => [row.id, row]));
const baseline = new Set(officialPlatformModules(source.directory));
for (const row of roster) for (const request of [...row.inject ?? [], ...row.external ?? []]) {
  if (!baseline.has(request) && !rows.has(request.replace(/\/client$/, ''))) throw new Error(`Missing official Web dependency ${request}`);
}
const unsorted = [];
// Weft contributes an ordinary native module, never a replacement workbench.
const environmentId = '@weft/harness-environment';
const environmentModule = await build({entryPoints: [resolve(root, 'apps/web/src/official/environment-plugin.ts')], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', minify: true, write: false, external: ['react', '@deepseek-ai/dsh-client-ui-primitives']});
const environmentFactory = `globalThis.__ModuleLoader__.load({id:${JSON.stringify(environmentId)},factory(require){const module={exports:{}};const exports=module.exports;${environmentModule.outputFiles[0].text}\nconst published={...module.exports};Object.defineProperty(published,Symbol.toStringTag,{value:'Module'});return published;}});`;
const environmentDirectory = resolve(output, 'harness', environmentId);
mkdirSync(environmentDirectory, {recursive: true});
writeFileSync(resolve(environmentDirectory, 'client.js'), environmentFactory);
const environmentRev = digest(environmentFactory);
unsorted.push({id: environmentId, url: `/harness/??${environmentId}/client.js&rev=${environmentRev}`, rev: environmentRev, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], inject: ['@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']});
for (const row of roster) {
  const directory = resolve(root, '.generated/official-ui', relative(source.directory, row.directory));
  const primary = ['client.js', 'client.browser.js'].find(file => existsSync(resolve(directory, file)));
  if (!primary) throw new Error(`Missing official client factory for ${row.id}`);
  const target = resolve(output, 'harness', row.id);
  mkdirSync(target, {recursive: true});
  for (const file of readdirSync(directory, {withFileTypes: true})) {
    if (file.name === 'types' || file.name.endsWith('.map') || file.name.endsWith('.d.ts')) continue;
    cpSync(resolve(directory, file.name), resolve(target, file.name), {recursive: true});
  }
  if (primary !== 'client.js') copyFileSync(resolve(directory, primary), resolve(target, 'client.js'));
  const rev = digest(readFileSync(resolve(target, 'client.js')));
  unsorted.push({id: row.id, url: `/harness/??${row.id}/client.js&rev=${rev}`, rev,
    ...(row.inject ? {inject: row.inject} : {}),
    ...(row.external ? {external: row.external} : {}),
    ...(row.immediately ? {immediately: true} : {}),
  });
}
// Build-time Node tooling only. Reuse the official ordering rule (external
// module edges); Cordis injection edges may contain legitimate service cycles.
const toolsSource = resolve(root, '.generated/official-boot-tools.ts');
writeFileSync(toolsSource, `export {orderByModuleGraph} from ${JSON.stringify(resolve(source.directory, 'packages/client/modules/src/index.ts'))};\nexport {parseBootManifest} from ${JSON.stringify(resolve(source.directory, 'packages/client/modules/src/client/manifest.ts'))};\n`);
const toolsPath = resolve(root, '.generated/official-boot-tools.mjs');
await build({entryPoints: [toolsSource], outfile: toolsPath, bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: resolve(root, '.generated/upstream.source.tsconfig.json')});
const {orderByModuleGraph, parseBootManifest} = await import(pathToFileURL(toolsPath).href);
const entries = orderByModuleGraph(unsorted);
const batches = entries.map(row => ({phase: row.id === '@deepseek-ai/dsh-client-modules' ? 'bootstrap' : 'application', url: row.url, rev: row.rev, entries: [row.id]}));
const version = JSON.parse(readFileSync(resolve(source.directory, 'packages/bundle/web-app/package.json'), 'utf8')).version;
const graph = {rev: digest(JSON.stringify({entries, batches})), release: {version, commit: source.commit}, entries, batches};
// Validate with the upstream parser, rather than maintaining a second Boot ABI.
parseBootManifest(graph);
writeFileSync(resolve(output, 'harness/boot.json'), JSON.stringify(graph) + '\n');
writeFileSync(resolve(root, '.generated/official-web-boot-report.json'), JSON.stringify({upstream: source.commit, built: report.entries.length, officialActive: roster.length, extensions: [environmentId], active: entries.length, modules: entries.map(row => row.id), disabled: report.entries.map(row => row.id).filter(id => !rows.has(id)), graph: relative(root, resolve(output, 'harness/boot.json'))}, null, 2) + '\n');
console.log(`Prepared ${roster.length} official Web entries and one Weft extension; validated the native Boot Graph.`);
