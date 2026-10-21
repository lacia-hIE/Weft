import { bindings, defineConfig, defineWorker, exports } from 'cf/config';

const accessAudience = 'a9f868c801ff9618d72eb834aeddbd37b2778f5ce054fef65c14168619d462b9';
const uiWorker = defineWorker({ name:'weft-ui-assets',entrypoint:'./dist/assets-worker.js',compatibilityDate:'2026-07-30',workersDev:false,previewUrls:false });

export default defineConfig({
  worker: {
    name: 'weft-kernel-validation',
    entrypoint: './dist/worker.js',
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'durable_object_io_tasks_prevent_eviction'],
    domains: ['weft.luxuncang.com'],
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: false },
      // Automatic spans for Durable Object RPC, D1 and subrequests show where a slow request spends its time.
      traces: { enabled: true, headSamplingRate: 1 },
    },
    // Local-only identity simulation; Cloudflare Access supplies production identity.
    access: { dev: { aud: accessAudience, identity: { user_uuid: 'local-developer', email: 'dev@example.com' } } },
    env: {
      UI: bindings.worker({ worker: uiWorker }),
      LOADER: bindings.workerLoader(),
      IMAGES: bindings.images(),
      SESSIONS: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'SessionDO' }),
      WORKSPACES: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'WorkspaceDO' }),
      ENVIRONMENTS: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'EnvironmentDO' }),
      TENANTS: bindings.durableObject({ worker: 'weft-kernel-validation', exportName: 'TenantDO' }),
      CONFIG_DB: bindings.d1({ name: 'weft-config', id: 'e0b7a68b-1af9-467e-986e-c2171c8f2dac' }),
      ACCESS_AUD: bindings.text(accessAudience),
      ACCESS_TEAM_DOMAIN: bindings.text('aigraph.cloudflareaccess.com'),
    },
    exports: {
      PluginCapabilities: exports.worker(),
      SessionDO: exports.durableObject({ storage: 'sqlite' }),
      WorkspaceDO: exports.durableObject({ storage: 'sqlite' }),
      EnvironmentDO: exports.durableObject({ storage: 'sqlite' }),
      TenantDO: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
