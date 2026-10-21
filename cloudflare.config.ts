import { bindings, defineConfig, defineContainer, defineWorker, exports } from 'cf/config';
import workspaceImage from './apps/workspace-container/image.json' with { type: 'json' };

const accessAudience = 'a9f868c801ff9618d72eb834aeddbd37b2778f5ce054fef65c14168619d462b9';
// Each workspace's Linux container, started by its WorkspaceDO when an environment runs commands there
// (scripts/workspace-container.mjs builds and pushes the image). One application per size an environment may choose.
const workspaceContainer = (size: 'basic' | 'standard-1' | 'standard-2', maxInstances: number) => defineContainer({
  name: `weft-workspace-shell-${size}`, image: { reference: workspaceImage.reference }, instanceType: size, maxInstances, observability: { logs: { enabled: true } },
});
const workspaceContainers = { basic: workspaceContainer('basic', 10), standard1: workspaceContainer('standard-1', 5), standard2: workspaceContainer('standard-2', 3) };
const uiWorker = defineWorker({ name:'weft-ui-assets',entrypoint:'./dist/assets-worker.js',compatibilityDate:'2026-07-30',workersDev:false,previewUrls:false });

export default defineConfig({
  containers: Object.values(workspaceContainers),
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
      // Host each workspace's container by size; unbound, because a bound Durable Object cannot host one (see container-host.ts).
      WorkspaceContainerBasicDO: exports.durableObject({ storage: 'sqlite', container: workspaceContainers.basic }),
      WorkspaceContainerStandard1DO: exports.durableObject({ storage: 'sqlite', container: workspaceContainers.standard1 }),
      WorkspaceContainerStandard2DO: exports.durableObject({ storage: 'sqlite', container: workspaceContainers.standard2 }),
      // computerd's connection back to its WorkspaceDO.
      WorkspaceProxy: exports.worker(),
      EnvironmentDO: exports.durableObject({ storage: 'sqlite' }),
      TenantDO: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
