import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeBuildOutput } from './write-build-output.mjs';

// Bundles have no adjacent package.json at runtime. Preserve upstream attribution
// while converting this one Node loader operation to a static JSON import.
const staticAttribution = {
  name: 'harness-static-attribution',
  setup(builder) {
    builder.onLoad({ filter: /packages\/llm\/llm\/src\/attribution\.ts$/ }, ({ path }) => {
      const original = readFileSync(path, 'utf8');
      const requireImport = "import { createRequire } from 'node:module'";
      const versionLoad = "const { version } = createRequire(import.meta.url)('../package.json') as { version: string }";
      if (!original.includes(requireImport) || !original.includes(versionLoad)) {
        throw new Error('Upstream attribution changed; review the static metadata adaptation.');
      }
      return {
        contents: original.replace(requireImport, "import { version } from '../package.json'").replace(versionLoad, ''),
        loader: 'ts',
        resolveDir: resolve(path, '..'),
      };
    });
  },
};

// Scope the fetch compatibility shim to the pinned Messages adapter only.
const providerFetch = {
  name: 'harness-workerd-provider-fetch',
  setup(builder) {
    builder.onLoad({ filter: /packages\/llm\/llm-deepseek\/src\/adapter\.ts$/ }, ({ path }) => {
      const original = readFileSync(path, 'utf8');
      if (!original.includes("body: extensions.payload, redirect: 'error'")) {
        throw new Error('Upstream provider transport changed; review the workerd fetch adaptation.');
      }
      return {
        contents: `import { fetchProvider as fetch } from ${JSON.stringify(resolve('packages/model-provider/src/fetch.ts'))};\n${original}`,
        loader: 'ts', resolveDir: resolve(path, '..'),
      };
    });
  },
};

mkdirSync('dist', { recursive: true });
const upstreamDirectory = JSON.parse(readFileSync('.generated/upstream-source.json','utf8')).directory;
const browserNodeModule = {
  name: 'official-loader-browser-boundary',
  setup(builder) {
    builder.onResolve({filter: /^node:module$/}, () => ({path: resolve(upstreamDirectory, 'apps/web/src/node-module-stub.ts')}));
  },
};
const dynamicCordis = await build({ entryPoints: [resolve(upstreamDirectory,'vendor/cordis/src/index.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2024', minify: true, write: false, tsconfig: '.generated/upstream.source.tsconfig.json' });
writeFileSync('.generated/dynamic-cordis.ts', `export const cordisModule = ${JSON.stringify(dynamicCordis.outputFiles[0].text)};\n`);
rmSync('dist/web', { recursive: true, force: true });
const web = await build({
  entryPoints: { app: 'apps/web/src/app.tsx', ...Object.fromEntries(Object.values(JSON.parse(readFileSync('packages/client-plugins/sdk.json','utf8'))).map(name => [`ui-runtime/${name}`, `apps/web/src/runtime/${name}.ts`])) },
  outdir: 'dist/web', bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  tsconfig: '.generated/upstream.source.tsconfig.json', jsx: 'automatic', minify: true, metafile: true,
  define: { 'process.env.NODE_ENV': '"production"', 'process.versions.node': '"0.0.0"', 'process.execArgv': '[]', 'process.env.CORDIS_SHARED': 'undefined' },
  plugins: [browserNodeModule],
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
const assets = {};
const primitives = web.metafile.outputs['dist/web/ui-runtime/primitives.js'].exports;
const dockkit = web.metafile.outputs['dist/web/ui-runtime/dockkit.js'].exports;
writeFileSync('.generated/browser-capabilities.ts',`export const primitiveExports: string[]=${JSON.stringify(primitives)};\nexport const dockkitExports: string[]=${JSON.stringify(dockkit)};\n`);
for (const output of Object.values(web.metafile.outputs)) {
  if (Object.entries(output.inputs ?? {}).some(([path,input])=>input.bytesInOutput > 0 && path.includes('micromark-extension-math/node_modules/katex/'))) {
    throw new Error('Old transitive KaTeX entered the browser bundle; use the reviewed direct renderer');
  }
}
function collectAssets(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collectAssets(path);
    else assets['/assets/' + path.slice('dist/web/'.length)] = { body: readFileSync(path, 'utf8'), type: entry.name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' };
  }
}
collectAssets('dist/web');
const bundledPackages = new Set();
for (const output of Object.values(web.metafile.outputs)) {
  for (const [path, input] of Object.entries(output.inputs ?? {})) {
    if (!input.bytesInOutput) continue;
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (match) bundledPackages.add(match[1]);
  }
}
let notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
for (const directory of [...bundledPackages].sort()) {
  const metadata = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
  const licenses = readdirSync(directory).filter(name => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  notices += `\n\n## ${metadata.name}@${metadata.version}\n`;
  for (const name of licenses) notices += `\n${readFileSync(`${directory}/${name}`, 'utf8')}\n`;
}
assets['/licenses.txt'] = { type:'text/plain; charset=utf-8', body:notices };
assets['/'] = { type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f2f5f9"><title>Weft · DeepSeek Harness</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"><p style="padding:32px;color:#8090a8">正在连接你的工作空间…</p></div><script type="module" src="/assets/app.js"></script></body></html>' };
rmSync('dist/public', { recursive: true, force: true });
for (const [path, asset] of Object.entries(assets)) {
  const target = resolve('dist/public', path === '/' ? 'index.html' : path.slice(1));
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, asset.body);
}
const paths = Object.keys(assets);
if (existsSync('.generated/official-web-assets/harness/boot.json')) {
  const graph = JSON.parse(readFileSync('.generated/official-web-assets/harness/boot.json', 'utf8'));
  if (graph.release?.commit !== JSON.parse(readFileSync('upstream.lock.json', 'utf8')).commit) throw new Error('Official Web assets are stale');
  cpSync('.generated/official-web-assets/harness', 'dist/public/harness', {recursive: true});
  function collectOfficial(directory, prefix) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.isDirectory()) collectOfficial(`${directory}/${entry.name}`, `${prefix}/${entry.name}`);
      else paths.push(`${prefix}/${entry.name}`);
    }
  }
  collectOfficial('dist/public/harness', '/harness');
}
writeFileSync('.generated/ui-paths.ts', `export const uiPaths: string[] = ${JSON.stringify(paths)};\n`);
writeFileSync('dist/web-metafile.json', JSON.stringify(web.metafile, null, 2) + '\n');
const result = await build({
  entryPoints: { worker: 'apps/worker/src/index.ts', 'assets-worker':'apps/assets/src/index.ts', 'contracts-worker': 'tests/fixtures/contracts-worker.ts', 'dynamic-worker': 'tests/fixtures/dynamic-worker.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  external: ['cloudflare:workers', 'node:*'],
  tsconfig: '.generated/upstream.source.tsconfig.json',
  plugins: [staticAttribution, providerFetch],
  sourcemap: true,
  metafile: true,
});
const forbiddenWorkspaceDependencies = ['just-bash', 'guarded-fetch', 'sprintf-js'];
const shippedInputs = Object.entries(result.metafile.outputs['dist/worker.js'].inputs)
  .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path);
if (shippedInputs.some(path => /packages\/(host\/webserver|api\/gateway)|node_modules\/ws\//.test(path))) {
  throw new Error('Node host transport leaked into the workerd application bundle');
}
for (const dependency of forbiddenWorkspaceDependencies) {
  if (shippedInputs.some(path => path.includes(`node_modules/${dependency}/`))) {
    throw new Error(`Unreviewed workspace execution dependency in application bundle: ${dependency}`);
  }
}
writeFileSync('dist/metafile.json', JSON.stringify(result.metafile, null, 2) + '\n');
const nodeImports = [...new Set(result.metafile.outputs['dist/worker.js'].imports
  .filter(item => item.path.startsWith('node:')).map(item => item.path))].sort();
writeFileSync('dist/runtime-audit.json', JSON.stringify({
  upstream: JSON.parse(readFileSync('upstream.lock.json', 'utf8')).commit,
  adaptations: ['Static LLM package version import', 'Messages adapter fetch rejects redirects manually in workerd'],
  computer: { version: JSON.parse(readFileSync('node_modules/@cloudflare/computer/package.json', 'utf8')).version, executionBackends: [] },
  excludedExecutionDependencies: forbiddenWorkspaceDependencies,
  browser: {
    protocol: 1,
    reused: ['Cordis Context', 'SlotRegistry', 'ui-renderer', 'store', 'Schemastery Config', 'ui-theme styles', 'ui-primitives controls', 'MarkdownText', 'DisclosureRow', 'sidebar/conversation/plugin page styles', 'layout column solver'],
    assets: Object.keys(assets).length,
    bytes: Object.values(web.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0),
  },
  pluginPackages: ['tool-todo', 'time-context', 'repeat-tool-reminder', 'skill', 'skill-filesystem', 'tool-skill', 'tool-cordis'],
  nodeImports,
  sourceFiles: Object.keys(result.metafile.outputs['dist/worker.js'].inputs).length,
  workerBytes: result.metafile.outputs['dist/worker.js'].bytes,
}, null, 2) + '\n');
console.log(`Worker bundled; Node compatibility imports: ${nodeImports.join(', ')}`);
await writeBuildOutput();
