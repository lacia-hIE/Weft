import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/**
 * The original runtime keeps per-home state in files under its harness home:
 * the anonymous user id and the DeepSeek upload index. A Worker isolate hosts
 * the objects of many tenants, so neither may live at module level or on the
 * isolate's filesystem. Both are read from the calling context's
 * `weftHarnessHome` service, which each environment's worlds mount with that
 * environment's persisted state. Any other caller of the id fails loudly.
 */
const STUB = `
export const ANONYMOUS_USER_ID_FILE_NAME = '.anonymous-user-id'
export function getOrCreateAnonymousUserId() {
  throw new Error('The anonymous user id belongs to an environment; read it from the context weftHarnessHome service')
}
export function environmentDeepSeekFiles(ctx) {
  const files = ctx.get('weftHarnessHome')?.deepSeekFiles
  if (files === undefined) throw new Error('This world has no environment DeepSeek file store')
  return files
}
export function environmentAnonymousUserId(ctx) {
  const id = ctx.get('weftHarnessHome')?.anonymousUserId
  if (typeof id !== 'string' || id.length === 0) throw new Error('This world has no environment harness home')
  return id
}
`;

export const nativeHarnessHomePlatform = {
  name: 'harness-native-harness-home-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/identity\/anonymous-user-id\/src\/index\.ts$/}, () => ({contents: STUB, loader: 'js'}));
    const seams = [
      [/packages\/llm\/llm-deepseek\/src\/host\.ts$/, 'resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),', 'resolveUserId: () => userId ??= environmentAnonymousUserId(ctx),\n    resolveFiles: () => environmentDeepSeekFiles(ctx),'],
      [/packages\/feedback\/command-feedback\/src\/index\.ts$/, 'Anonymous user: ${getOrCreateAnonymousUserId()}.', 'Anonymous user: ${environmentAnonymousUserId(invocation.agent.ctx)}.'],
    ];
    for (const [filter, before, after] of seams) {
      builder.onLoad({filter}, ({path}) => {
        const source = readFileSync(path, 'utf8');
        const importLine = "import { getOrCreateAnonymousUserId";
        if (!source.includes(before) || !source.includes(importLine)) throw new Error(`Upstream anonymous user id seam changed in ${path}`);
        return {
          contents: source.replace(importLine, 'import { environmentAnonymousUserId, environmentDeepSeekFiles, getOrCreateAnonymousUserId').replace(before, after),
          loader: 'ts', resolveDir: resolve(path, '..'),
        };
      });
    }
  },
};
