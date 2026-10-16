import { bindings, defineConfig, exports } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'weft-kernel-validation',
    entrypoint: './dist/worker.js',
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    domains: ['weft.luxuncang.com'],
    env: {
      SESSIONS: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'SessionDO' }),
      VALIDATION_AUTH_JSON: bindings.secret(),
    },
    exports: {
      SessionDO: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
