import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import {build as bundleSource} from 'esbuild';
import {createHash} from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const output = resolve(root, '.generated');
const sourcePath = path => {
  const result = relative(output, path);
  return result.startsWith('.') ? result : './' + result;
};
mkdirSync(output, { recursive: true });
const configuredCheckout = resolve(root, lock.directory);
let checkout = configuredCheckout;
if (existsSync(checkout)) {
  const existing = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (existing !== lock.commit || dirty) {
    checkout = resolve(output, 'upstream', lock.commit);
    console.log('Preserving the existing Harness checkout; using an isolated pinned source copy.');
  }
}
if (!existsSync(checkout)) {
  mkdirSync(resolve(checkout, '..'), { recursive: true });
  execFileSync('git', ['clone', '--no-checkout', lock.repository, checkout], { stdio: 'inherit' });
  execFileSync('git', ['-C', checkout, 'checkout', '--detach', lock.commit], { stdio: 'inherit' });
}
const actual = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actual !== lock.commit) throw new Error(`Upstream commit mismatch: expected ${lock.commit}, got ${actual}. Checkout was not modified.`);
const changes = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
if (changes.trim()) throw new Error('Upstream has tracked changes. Resolve them before validating the pinned source.');
const config = ts.readConfigFile(resolve(checkout, 'tsconfig.base.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const paths = Object.fromEntries(Object.entries(config.config.compilerOptions.paths).map(([name, targets]) => [
  name, targets.map(target => sourcePath(resolve(checkout, target))),
]));
paths['@weft/upstream/*'] = [sourcePath(checkout) + '/*'];
writeFileSync(resolve(output, 'upstream-source.json'), JSON.stringify({ directory: checkout, commit: actual }) + '\n');
writeFileSync(resolve(output, 'upstream.source.tsconfig.json'), JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n');
// Vendored libraries use their own relaxed compiler settings upstream. Emit their
// declarations separately so Weft and Harness packages retain strict checking.
const vendorNames = {cordis: 'cordis', cosmokit: 'cosmokit', schemastery: 'schemastery', loader: 'cordis-plugin-loader', include: 'cordis-plugin-include'};
const declarationOnlyPackages = {
  '@deepseek-ai/dsh-repeat-tool-reminder': 'packages/guard/repeat-tool-reminder/src/index.ts',
  // Inspection references the gateway's types; its Node HTTP implementation is
  // never bundled into Weft. Consume its own declarations at this boundary.
  '@deepseek-ai/dsh-api-gateway': 'packages/api/gateway/src/index.ts',
  // Keep each Host class and its internal imports on the same declaration
  // boundary. Runtime builds still resolve the unmodified original sources.
  '@deepseek-ai/dsh-experimental-agent-team': 'packages/experimental/agent-team/src/index.ts',
  '@deepseek-ai/dsh-experimental-tool-agent-team': 'packages/experimental/tool-agent-team/src/index.ts',
  '@deepseek-ai/dsh-subagent': 'packages/subagent/subagent/src/index.ts',
  '@deepseek-ai/dsh-subagent/internal': 'packages/subagent/subagent/src/internal.ts',
  '@deepseek-ai/dsh-agent-preset-registry': 'packages/preset/agent-preset-registry/src/index.ts',
  // Schedule's public types reach the full session controller and typert registry
  // sources; consume its declarations while the runtime bundles the original.
  '@deepseek-ai/dsh-schedule': 'packages/schedule/schedule/src/index.ts',
  '@deepseek-ai/dsh-app-boot': 'packages/boot/app-boot/src/index.ts',
  '@deepseek-ai/dsh-cmdline': 'packages/boot/cmdline/src/index.ts',
  '@deepseek-ai/dsh-hmr': 'packages/boot/hmr/src/index.ts',
  '@deepseek-ai/dsh-config-editor': 'packages/boot/config-editor/src/index.ts',
  // Browser boot has its own compilation face; avoid mixing its public types
  // with the Host's augmented Context while checking Weft's integration code.
  '@deepseek-ai/dsh-client-web': 'packages/client/web/src/index.ts',
  '@deepseek-ai/dsh-client-modules/client': 'packages/client/modules/src/client/index.ts',
  '@deepseek-ai/dsh-client-connection/client': 'packages/client/connection/src/client/index.ts',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver/package.json',
};
// This pinned upstream module has a broad-union MessageSource spread which its
// standalone source check rejects. Consume its declarations without changing it;
// real workerd tests verify the plugin's runtime behavior and event vocabulary.
const vendorEntries = [...Object.keys(vendorNames).map(name => resolve(checkout, 'vendor', name, 'src/index.ts')), ...Object.values(declarationOnlyPackages).map(path => resolve(checkout, path))];
const absolutePaths = Object.fromEntries(Object.entries(config.config.compilerOptions.paths).map(([name, targets]) => [
  name, targets.map(target => resolve(checkout, target)),
]));
const declarationProgram = ts.createProgram(vendorEntries, {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true,
  emitDeclarationOnly: true,
  noCheck: true,
  rootDir: checkout,
  outDir: resolve(output, 'types'),
  paths: absolutePaths,
});
const emitted = declarationProgram.emit();
if (emitted.emitSkipped) throw new Error('Unable to emit pinned vendor declarations');
const typePaths = { ...paths };
for (const [name, moduleName] of Object.entries(vendorNames)) typePaths[`@deepseek-ai/${moduleName}`] = [`./types/vendor/${name}/src/index.d.ts`];
for (const [name, path] of Object.entries(declarationOnlyPackages)) typePaths[name] = [`./types/${path.replace(/\.ts$/, '.d.ts')}`];
// Include ambient declarations from the selected checkout, whether it is the
// configured CI directory or the isolated source copy used for a dirty checkout.
const ambientDeclarations = [
  'packages/web/tool-web/src/turndown-plugin-gfm.d.ts',
  'packages/fs/tool-fs-search/src/ripgrep.d.ts',
].map(path => sourcePath(resolve(checkout, path)));
writeFileSync(resolve(output, 'upstream.tsconfig.json'), JSON.stringify({ compilerOptions: { paths: typePaths }, files: ambientDeclarations }, null, 2) + '\n');
console.log(`Pinned Harness ${actual.slice(0, 12)}; generated source aliases.`);

// The official profile's bundle patches in the Loader's entry-list dialect:
// `!!js` scalars become `{__jsExpr}` nodes, exactly as the include package
// parses them. Weft's overlay must resolve every one that stays enabled.
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {kind: 'scalar', resolve: data => typeof data === 'string', construct: data => ({__jsExpr: data})});
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
const officialBundles = Object.fromEntries(['base', 'web-app'].map(bundle => [bundle, yaml.load(readFileSync(resolve(checkout, 'packages/bundle', bundle, 'cordis.patch.yml'), 'utf8'), {schema: entryListSchema})]));
writeFileSync(resolve(output, 'official-bundles.json'), JSON.stringify(officialBundles, null, 2) + '\n');

// Display metadata of every upstream plugin package (`locale/<lang>.json` → `meta`), and the
// package each official profile or preset row names. workerd reads no package directories, so
// the plugin inventory's `pluginPackages` lookup is served from this table.
const pluginMeta = {packages: {}, rows: {}};
for (const group of readdirSync(resolve(checkout, 'packages'), {withFileTypes: true})) {
  if (!group.isDirectory()) continue;
  for (const entry of readdirSync(resolve(checkout, 'packages', group.name), {withFileTypes: true})) {
    const directory = resolve(checkout, 'packages', group.name, entry.name);
    if (!entry.isDirectory() || !existsSync(resolve(directory, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    const name = manifest.name;
    const meta = {};
    for (const language of ['en', 'zh']) {
      const file = resolve(directory, 'locale', `${language}.json`);
      if (!existsSync(file)) continue;
      const value = JSON.parse(readFileSync(file, 'utf8')).meta ?? {};
      for (const field of ['title', 'description']) if (typeof value[field] === 'string') (meta[field] ??= {})[language] = value[field];
    }
    // Localized text always carries English: as in the original manifest reader, a missing English
    // title falls back to the package name and a missing English description to package.json's.
    if (meta.title && meta.title.en === undefined) meta.title.en = name.replace(/^@deepseek-ai\/dsh-/, '');
    if (meta.description && meta.description.en === undefined) {
      if (typeof manifest.description === 'string') meta.description.en = manifest.description;
      else delete meta.description;
    }
    if (Object.keys(meta).length) pluginMeta.packages[name] = meta;
  }
}
const presetPatches = readdirSync(resolve(checkout, 'packages/bundle/web-app/presets')).filter(file => file.endsWith('.yml'))
  .map(file => yaml.load(readFileSync(resolve(checkout, 'packages/bundle/web-app/presets', file), 'utf8'), {schema: entryListSchema}));
const collectRows = value => {
  if (Array.isArray(value)) { value.forEach(collectRows); return; }
  if (value === null || typeof value !== 'object') return;
  if (typeof value.id === 'string' && typeof value.name === 'string' && value.name.startsWith('@deepseek-ai/')) pluginMeta.rows[value.id] ??= value.name;
  Object.values(value).forEach(collectRows);
};
collectRows([officialBundles, presetPatches]);
// The official Web presets (standard, ptc, minimal, cordis), as the Agent preset rows their patches insert.
const officialPresets = presetPatches.flatMap(patch => patch.flatMap(operation => operation.insert ?? [])).filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => row.config).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
writeFileSync(resolve(output, 'official-presets.json'), JSON.stringify(officialPresets, null, 2) + '\n');
writeFileSync(resolve(output, 'plugin-meta.json'), JSON.stringify(pluginMeta) + '\n');

// Optional official bundles are admitted from this exact clean checkout only.
// Persist both patch and provenance; runtime installs never fetch or evaluate YAML.
const optionalBundles = ['agent-team-profile'].map(id => {
  const directory = resolve(checkout, 'packages/experimental', id);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const patchPath = manifest.dsh?.bundle?.patch;
  if (patchPath !== './cordis.patch.yml') throw new Error('Unsupported official bundle patch declaration');
  const source = readFileSync(resolve(directory, patchPath), 'utf8');
  const patch = yaml.load(source, {schema: yaml.JSON_SCHEMA});
  return {name: manifest.name, version: manifest.version, description: manifest.description,
    upstream: actual, digest: createHash('sha256').update(actual).update('\0').update(source).digest('hex'), patch};
});
writeFileSync(resolve(output, 'official-optional-bundles.json'), JSON.stringify(optionalBundles, null, 2) + '\n');

// Versions whose module identity is owned by the running platform.
const packagePlatformVersions = {react: '18.3.1'};
for (const [name, path] of Object.entries({
  '@deepseek-ai/cordis': 'vendor/cordis/package.json',
  '@deepseek-ai/dsh-tools': 'packages/core/tools/package.json',
  '@deepseek-ai/dsh-session': 'packages/core/session/package.json',
  '@deepseek-ai/dsh-webhook': 'packages/experimental/webhook/package.json',
  '@deepseek-ai/dsh-credentials': 'packages/credentials/credentials/package.json',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver/package.json',
  '@deepseek-ai/dsh-util-values': 'packages/util/values/package.json',
  '@deepseek-ai/schemastery': 'vendor/schemastery/package.json',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives/package.json',
})) packagePlatformVersions[name] = JSON.parse(readFileSync(resolve(checkout, path), 'utf8')).version;
writeFileSync(resolve(output, 'package-platform-versions.json'), JSON.stringify(packagePlatformVersions) + '\n');

// The compiler consumes the exact upstream patch implementation, with no user code execution.
await bundleSource({stdin: {contents: "export {applyEntryPatches} from '@deepseek-ai/cordis-plugin-include'", resolveDir: root},
  outfile: resolve(root, 'apps/plugin-builder/patch.mjs'), bundle: true, platform: 'node', format: 'esm',
  tsconfig: resolve(output, 'upstream.source.tsconfig.json'), logLevel: 'error'});
