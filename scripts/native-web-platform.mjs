import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Keep the original web fetch provider (URL policy, same-origin redirects, size,
 * charset and timeout limits) and replace only its Undici transport: workerd
 * fetches through the platform, which resolves names at the edge and refuses
 * IP-address hostnames.
 */
export const nativeWebPlatform = {
  name: 'harness-native-web-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/web\/web-fetch-http\/src\/provider\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const before = "const { fetch } = await import('undici')\n      return await fetch(url, { method: 'GET', redirect: 'manual', headers, signal })";
      if (!source.includes(before)) throw new Error('Upstream web-fetch-http transport changed; review the workerd fetch');
      return {contents: source.replace(before, "return await globalThis.fetch(url, { method: 'GET', redirect: 'manual', headers, signal }) as never"), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    // Workers reject `redirect: 'error'`; with `manual`, the provider's own `!response.ok` branch reports a 3xx as an endpoint error.
    builder.onLoad({filter: /packages\/web\/web-search-deepseek\/src\/provider\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const before = "method: 'POST',\n        redirect: 'error',";
      if (!source.includes(before) || !source.includes('if (!response.ok) {')) throw new Error('Upstream DeepSeek search transport changed; review the workerd redirect policy');
      return {contents: source.replace(before, "method: 'POST',\n        redirect: 'manual',"), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onLoad({filter: /packages\/web\/web-deepseek-api\/src\/transport\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const before = "redirect: 'error',";
      if (!source.includes(before) || !source.includes('if (!response.ok) {')) throw new Error('Upstream DeepSeek web API transport changed; review the workerd redirect policy');
      return {contents: source.replace(before, "redirect: 'manual',"), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    // workerd has no DOMParser; turndown's own Node build parses HTML with domino.
    builder.onResolve({filter: /^turndown$/}, () => ({path: require.resolve('turndown/lib/turndown.cjs.js')}));
    builder.onResolve({filter: /^@mixmark-io\/domino$/}, () => ({path: require.resolve('@mixmark-io/domino')}));
  },
};
