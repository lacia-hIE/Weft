import {resolve} from 'node:path';

const stub = resolve(import.meta.dirname, '../apps/web/src/official/node-browser-external.ts');

/**
 * Upstream's Vite build turns the pinned Loader's filesystem resolver imports into
 * browser-external stubs; browser boot supplies `loader.internal`, so that resolver
 * never runs. Only imports from that one module are redirected.
 */
export const browserLoaderResolver = {
  name: 'official-loader-browser-resolver',
  setup(builder) {
    builder.onResolve({filter: /^node:(fs|fs\/promises|path|url)$/}, ({importer}) => importer.replaceAll('\\', '/').endsWith('/vendor/loader/src/resolve.ts') ? {path: stub} : undefined);
  },
};
