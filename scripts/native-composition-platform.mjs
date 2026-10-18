import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Keep original Loader/preset lifecycle; replace only unavailable host facilities. */
export const nativeCompositionPlatform = {
  name: 'harness-native-composition-platform',
  setup(builder) {
    builder.onResolve({filter: /^\.\/internal\.ts$/}, ({importer}) => importer.endsWith('/vendor/loader/src/index.ts') ? {path: resolve('packages/native-composition/src/loader-internals.ts')} : undefined);
    builder.onResolve({filter: /^@deepseek-ai\/dsh-app-boot$/}, ({importer}) => importer.endsWith('/agent-preset-registry/src/mount.ts') ? {path: resolve('packages/native-composition/src/admission.ts')} : undefined);
    builder.onLoad({filter: /vendor\/loader\/src\/config\/utils\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const expression = "export const evaluate = new Function('ctx', 'expr', `\n  with (ctx) {\n    return eval(expr)\n  }\n`) as ((ctx: object, expr: string) => any)";
      if (!source.includes(expression)) throw new Error('Upstream Loader expression seam changed; review the workerd admission boundary');
      return {contents: source.replace(expression, "export const evaluate = (_ctx: object, _expr: string): never => {throw new Error('JavaScript configuration expressions are not supported by the workerd host')}"), loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
