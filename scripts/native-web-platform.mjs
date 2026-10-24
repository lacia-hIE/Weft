import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Keep the original web fetch provider (URL policy, same-origin redirects, size,
 * charset and timeout limits) and replace only its Node transport: workerd fetches
 * through the platform, which resolves names at the edge. IP-literal targets are
 * still checked with the original address classification.
 */
export const nativeWebPlatform = {
  name: 'harness-native-web-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/web\/web-fetch-http\/src\/network\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      for (const [before, after] of [
        ["import { lookup as systemLookup } from 'node:dns/promises'\n", "const systemLookup: AddressResolver = () => Promise.reject(new Error('workerd resolves hostnames at the edge'))\n"],
        ["import { isIP } from 'node:net'\n", "const isIP = (value: string): 0 | 4 | 6 => ipaddr.IPv4.isValidFourPartDecimal(value) ? 4 : ipaddr.IPv6.isValid(value) ? 6 : 0\n"],
        ["const { Agent, fetch } = await import('undici')", "const { Agent, fetch }: any = (() => { throw new Error('Undici is not available in workerd') })()"],
        ["const { fetch } = await import('undici')", "const { fetch }: any = (() => { throw new Error('Undici is not available in workerd') })()"],
        ["export const publicHttpNetwork = {\n  resolve: resolvePublicAddresses,\n  request: requestPinned,\n  requestVia,\n}", `export const publicHttpNetwork = {
  resolve: async (hostname: string): Promise<PublicAddress[]> => {
    if (isNonPublicIpLiteral(hostname)) throw new WebError(\`URL hostname "\${hostname}" is a non-public IP address\`, 'WEB_BLOCKED_URL')
    return []
  },
  request: async (url: URL, _addresses: readonly PublicAddress[], headers: Record<string, string>, signal: AbortSignal): Promise<PinnedResponse> => ({
    response: await globalThis.fetch(url, {method: 'GET', redirect: 'manual', headers, signal}) as never,
    close: async () => {},
  }),
  requestVia,
}`],
      ]) {
        if (!source.includes(before)) throw new Error('Upstream web-fetch-http network seam changed; review the workerd transport');
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
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
