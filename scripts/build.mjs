import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

mkdirSync('dist', { recursive: true });
const result = await build({
  entryPoints: { worker: 'apps/worker/src/index.ts', 'contracts-worker': 'tests/fixtures/contracts-worker.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  external: ['cloudflare:workers', 'node:*'],
  tsconfig: '.generated/upstream.source.tsconfig.json',
  plugins: [staticAttribution],
  sourcemap: true,
  metafile: true,
});
writeFileSync('dist/metafile.json', JSON.stringify(result.metafile, null, 2) + '\n');
const nodeImports = [...new Set(result.metafile.outputs['dist/worker.js'].imports
  .filter(item => item.path.startsWith('node:')).map(item => item.path))].sort();
writeFileSync('dist/runtime-audit.json', JSON.stringify({
  upstream: JSON.parse(readFileSync('upstream.lock.json', 'utf8')).commit,
  adaptation: 'Static package version import in packages/llm/llm/src/attribution.ts',
  nodeImports,
  sourceFiles: Object.keys(result.metafile.outputs['dist/worker.js'].inputs).length,
  workerBytes: result.metafile.outputs['dist/worker.js'].bytes,
}, null, 2) + '\n');
console.log(`Worker bundled; Node compatibility imports: ${nodeImports.join(', ')}`);
