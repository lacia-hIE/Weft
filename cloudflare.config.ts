import { bindings, defineConfig, defineContainer, defineWorker, exports } from 'cf/config';
import workspaceImage from './apps/workspace-container/image.json' with { type: 'json' };
import pluginBuilderImage from './apps/plugin-builder/image.json' with {type: 'json'};
import {deployment} from './scripts/deployment-config.ts';

const accessAudience = deployment.accessAudience ?? 'weft-local-development';
// Each workspace's Linux container, started by its WorkspaceDO when an environment runs commands there
// (scripts/workspace-container.mjs builds and pushes the image). One application per size an environment may choose.
const workspaceContainer = (size: 'basic' | 'standard-1' | 'standard-2', maxInstances: number) => defineContainer({
  name: `${deployment.workspaceContainerPrefix}-${size}`, image: { reference: deployment.workspaceImage ?? workspaceImage.reference }, instanceType: size, maxInstances, observability: { logs: { enabled: true } },
});
const workspaceContainers = { basic: workspaceContainer('basic', 10), standard1: workspaceContainer('standard-1', 5), standard2: workspaceContainer('standard-2', 3) };
const pluginBuilder = defineContainer({name: deployment.pluginBuilderName, image: {reference: deployment.pluginBuilderImage ?? pluginBuilderImage.reference}, instanceType: 'basic', maxInstances: 2, observability: {logs: {enabled: true}}});
const uiWorker = defineWorker({ name:deployment.uiWorkerName,entrypoint:'./dist/assets-worker.js',compatibilityDate:'2026-07-30',workersDev:false,previewUrls:false });

export default defineConfig({
  containers: [workspaceContainers.basic, workspaceContainers.standard1, workspaceContainers.standard2, pluginBuilder],
  worker: {
    name: deployment.workerName,
    entrypoint: './dist/worker.js',
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'durable_object_io_tasks_prevent_eviction'],
    domains: deployment.domain ? [deployment.domain] : [],
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
      PLUGIN_ARTIFACTS: bindings.r2({name: deployment.artifactBucketName}),
      SESSIONS: bindings.durableObject({ worker: deployment.workerName, exportName: 'SessionDO' }),
      WORKSPACES: bindings.durableObject({ worker: deployment.workerName, exportName: 'WorkspaceDO' }),
      ENVIRONMENTS: bindings.durableObject({ worker: deployment.workerName, exportName: 'EnvironmentDO' }),
      TENANTS: bindings.durableObject({ worker: deployment.workerName, exportName: 'TenantDO' }),
      CONFIG_DB: bindings.d1({ name: deployment.databaseName, ...(deployment.databaseId ? {id: deployment.databaseId} : {}) }),
      ACCESS_AUD: bindings.text(accessAudience),
      ACCESS_TEAM_DOMAIN: bindings.text(deployment.accessTeamDomain ?? 'local.cloudflareaccess.com'),
    },
    exports: {
      PluginCapabilities: exports.worker(),
      PluginBuilderDO: exports.durableObject({storage: 'sqlite', container: pluginBuilder}),
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
