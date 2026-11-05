import {resolve} from 'node:path';

/**
 * Packages the pinned upstream imports by their CommonJS default export, as Node
 * resolves them. Their `module` fields name ES builds without that default, so
 * browser-platform bundles resolve the package `main` instead.
 */
const COMMONJS_DEFAULTS = {rrule: 'node_modules/rrule/dist/es5/rrule.js'};

export const commonJsEntryPlatform = {
  name: 'weft-commonjs-entry-platform',
  setup(builder) {
    builder.onResolve({filter: /^rrule$/}, ({path}) => ({path: resolve(import.meta.dirname, '..', COMMONJS_DEFAULTS[path])}));
  },
};
