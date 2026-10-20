import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Compose the official Web profile with Weft's overlay at build time, fail the
 * build when the overlay leaves a row unclassified or an enabled `!!js`
 * expression unresolved, and expose exactly the enabled rows' modules to the
 * Worker as `weft:official-modules` (a static module table, since workerd
 * imports nothing at runtime).
 */
export async function officialProfilePlugin() {
  const outfile = resolve('.generated/official-profile.mjs');
  await build({entryPoints: ['packages/harness-profile/src/official.ts'], outfile, bundle: true, platform: 'node', format: 'esm', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error'});
  const profile = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  const problems = profile.overlayProblems();
  if (problems.length) throw new Error(`The official profile overlay is incomplete:\n${problems.join('\n')}`);
  const names = profile.enabledModuleNames();
  const contents = names.map((name, index) => `import * as m${index} from ${JSON.stringify(name)};`).join('\n')
    + `\nexport default {${names.map((name, index) => `${JSON.stringify(name)}: m${index}`).join(', ')}};\n`;
  return {
    name: 'weft-official-modules',
    setup(builder) {
      builder.onResolve({filter: /^weft:official-modules$/}, () => ({path: 'official-modules', namespace: 'weft-official'}));
      builder.onLoad({filter: /.*/, namespace: 'weft-official'}, () => ({contents, loader: 'js', resolveDir: resolve('.')}));
    },
  };
}
