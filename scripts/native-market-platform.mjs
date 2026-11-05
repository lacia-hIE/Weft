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
    // Workers run no Git: detail reads use the original single-file APIs, the
    // anonymous visibility check stays the original fetch, and a document that
    // needs a partial clone reports the original `git-unavailable` failure.
    builder.onLoad({filter: /packages\/boot\/plugin-market\/src\/repository-cache\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const from = source.indexOf('  private async check(url: string): Promise<boolean> {');
      const to = source.indexOf('\n  }\n', from);
      if (!source.includes('export class RepositoryCache {') || !source.includes('export interface RepositoryCacheOptions {') || from < 0 || to < 0 || !source.slice(from, to).includes('/info/refs?service=git-upload-pack')) throw new Error('Upstream plugin market repository cache changed; review the workerd detail reader');
      const options = source.slice(source.indexOf('export interface RepositoryCacheOptions {'), source.indexOf('\n}\n', source.indexOf('export interface RepositoryCacheOptions {')) + 3);
      return {
        contents: "import { DetailFailure, type FoundFile } from '@deepseek-ai/dsh-plugin-detail'\n" + options
          + 'interface Expiring<T> { readonly value: T; readonly expiresAt: number }\n'
          + 'const unavailable = (url: string): DetailFailure => new DetailFailure(\'git-unavailable\', `Reading ${url} needs a Git clone, which this deployment does not run`)\n'
          + 'export class RepositoryCache {\n  private readonly visibility = new Map<string, Expiring<boolean>>()\n  private readonly checks = new Map<string, Promise<boolean>>()\n'
          + '  constructor(private readonly options: RepositoryCacheOptions) {}\n'
          + '  isPublic(url: string): Promise<boolean> {\n    const cached = this.visibility.get(url)\n    if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)\n'
          + '    let pending = this.checks.get(url)\n    if (pending === undefined) {\n      pending = this.check(url).finally(() => { this.checks.delete(url) })\n      this.checks.set(url, pending)\n    }\n    return pending\n  }\n'
          + source.slice(from, to) + '\n  }\n'
          + '  read(url: string, _commit: string | undefined, _path: string, _maxBytes: number, _signal: AbortSignal): Promise<Uint8Array | undefined> { return Promise.reject(unavailable(url)) }\n'
          + '  readme(url: string, _commit: string | undefined, _dir: string, _maxBytes: number, _signal: AbortSignal): Promise<FoundFile | undefined> { return Promise.reject(unavailable(url)) }\n'
          + '  async settled(): Promise<void> {}\n}\n',
        loader: 'ts', resolveDir: resolve(path, '..'),
      };
    });
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
