import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Keep the pinned lifecycle intact; replace only VM and registry ownership seams. */
export const nativeCordisPlatform = {
  name: 'harness-native-cordis-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/extensions\/cordis-host-runner\/src\/index\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      for (const [before, after] of [
        ['private readonly registry = new DynamicCordisRegistry()', 'private readonly registry = this.ctx.weftNativePluginRegistry'],
        ['createSandbox(plugin.pluginId, { handle })', 'createSandbox(this.rootCtx, plugin.pluginId, run.pluginRunId, { handle })'],
      ]) {
        if (!source.includes(before)) throw new Error('Upstream Cordis Host platform seam changed; review the adaptation');
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onResolve({filter: /^\.\/sandbox\.ts$/}, ({importer}) => importer.endsWith('/extensions/cordis-host-runner/src/index.ts') ? {path: resolve('packages/native-plugins/src/sandbox.ts')} : undefined);
    builder.onLoad({filter: /packages\/extensions\/cordis-host-runner\/src\/inspect-registry\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8'), mint = '`inspect-${this.nextRequest++}`';
      if (!source.includes(mint)) throw new Error('Upstream Cordis inspect identity seam changed; review environment-wide ownership');
      return {contents: source.replace(mint, '`inspect-${crypto.randomUUID()}`'), loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
