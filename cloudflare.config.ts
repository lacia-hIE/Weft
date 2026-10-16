import { bindings, defineConfig, exports } from 'cf/config';

const accessAudience = 'a9f868c801ff9618d72eb834aeddbd37b2778f5ce054fef65c14168619d462b9';

export default defineConfig({
  worker: {
    name: 'weft-kernel-validation',
    entrypoint: './dist/worker.js',
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    domains: ['weft.luxuncang.com'],
    workersDev: false,
    previewUrls: false,
    // Local-only identity simulation; Cloudflare Access supplies production identity.
    access: { dev: { aud: accessAudience, identity: { user_uuid: 'local-developer', email: 'dev@example.com' } } },
    env: {
      SESSIONS: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'SessionDO' }),
      MODEL_BACKEND: bindings.text('deepseek'),
      DEEPSEEK_MODEL: bindings.text('deepseek-flash'),
      DEEPSEEK_API_KEY: bindings.secret(),
      ACCESS_AUD: bindings.text(accessAudience),
      ACCESS_TEAM_DOMAIN: bindings.text('aigraph.cloudflareaccess.com'),
    },
    exports: {
      SessionDO: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
