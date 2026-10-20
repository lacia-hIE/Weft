import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/**
 * Keep the original plugin market reader (index URLs, fetch limits, search,
 * compatibility and installation status) and replace only its Node platform:
 * the index parses in the calling isolate instead of a Worker Thread, the dsh
 * runtime version is fixed at build time instead of read from package.json, and
 * Workers' `manual` redirects stand in for `error`, so the reader's own
 * `!response.ok` branch reports a 3xx as a fetch failure.
 */
export const nativeMarketPlatform = {
  name: 'harness-native-market-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/boot\/plugin-market\/src\/parse-thread\.ts$/}, ({path}) => ({
      contents: "import { parseIndexBody, type IndexParseResult } from './parse.ts'\n"
        + 'export async function parseIndexInWorker(body: Uint8Array, url: string, signal: AbortSignal): Promise<IndexParseResult> {\n'
        + '  signal.throwIfAborted()\n  return parseIndexBody(body, url)\n}\n',
      loader: 'ts', resolveDir: resolve(path, '..'),
    }));
    builder.onLoad({filter: /packages\/boot\/plugin-market\/src\/index\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      const appBoot = resolve(path, '../../../app-boot');
      const version = JSON.parse(readFileSync(resolve(appBoot, 'package.json'), 'utf8')).version;
      for (const [before, after] of [
        ["import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'\n",
          `import { evaluatePluginCompatibility } from ${JSON.stringify(resolve(appBoot, 'src/plugin-compatibility.ts'))}\nconst getDshRuntimeVersion = (): string => ${JSON.stringify(version)}\n`],
        ["response = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })",
          "response = await fetch(url, { signal, redirect: 'manual', headers: { accept: 'application/json' } })"],
      ]) {
        if (!source.includes(before) || !source.includes('if (!response.ok) {')) throw new Error('Upstream plugin market platform seam changed; review the workerd reader');
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
