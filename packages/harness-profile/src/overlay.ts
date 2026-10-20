import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';

/**
 * Weft's overlay over the official Web profile. Every host row of the
 * composed `base` + `web-app` profile appears in exactly one table below; the
 * build fails when an upstream row is added, renamed or left unclassified.
 *
 * - `LOADED`: loaded by the world's `WorkerdLoader` exactly as the profile declares it.
 * - `MOUNTED_BY_WEFT`: the original package is already mounted by Weft's world
 *   setup; disabled here so its service is not registered twice. Rows move to
 *   `LOADED` as the setup migrates to the profile.
 * - `PLATFORM`: the row's implementation is a Node host provider; a Cloudflare
 *   implementation serves the same service.
 * - `NOT_APPLICABLE`: desktop, telemetry and development rows with no Web role.
 * - `EXTERNAL`: needs a Cloudflare service not yet provisioned.
 * - `PENDING`: needs a Weft provider that does not exist yet; each note names it.
 * Browser rows (`client-*` packages) are served by the Boot Graph, not the host Loader.
 */

/** Rows loaded from the profile, with the world that loads them. */
export const LOADED: Record<string, {world: 'session'}> = {
  'timer': {world: 'session'},
  'llm-retry': {world: 'session'},
  'deepseek-llm-api-extensions': {world: 'session'},
  'session-log-deepseek': {world: 'session'},
  'session-title-llm': {world: 'session'},
  'timeout-policy': {world: 'session'},
  'session-checkpoint-policy': {world: 'session'},
  'image-offload': {world: 'session'},
  'session-stats': {world: 'session'},
  'session-turn-outline': {world: 'session'},
};

/** Original packages that Weft's world setup mounts today. */
export const MOUNTED_BY_WEFT: Record<string, string> = {
  'llm': 'harness-runtime root', 'session': 'harness-runtime root', 'session-projection': 'harness-runtime root',
  'token-meter': 'harness-runtime root', 'commands': 'harness-runtime root', 'user-questions': 'harness-runtime root',
  'subagent-model-selection-settings': 'harness-runtime root', 'session-title': 'harness-runtime root',
  'system-prompt': 'harness-runtime root', 'tools': 'harness-runtime root', 'agent': 'harness-runtime root',
  'goal': 'harness-runtime root', 'goal-round-driver': 'harness-runtime root', 'agent-loop': 'harness-runtime root',
  'agent-preset-registry': 'native-composition', 'llm-deepseek': 'native-models', 'llm-pi-ai': 'native-models',
  'agent-default-model': 'environment settings', 'jobs': 'workspace shell', 'shell-env': 'workspace shell',
  'sandbox-policy': 'workspace shell', 'approval': 'native permissions', 'permission': 'native permissions',
  'subagent': 'native-subagents', 'subagent-spawn-in-process': 'native-subagents', 'subagent-fork-in-process': 'native-subagents',
  'command-feedback': 'native interaction', 'message-feedback': 'native interaction', 'web': 'native interaction',
  'web-search-deepseek': 'native interaction', 'web-fetch-http': 'native interaction', 'schedule': 'native-schedule',
  'session-reference': 'native interaction', 'file-reference-local': 'native-files', 'working-directory': 'workspace provider',
  'workspace': 'native workspaces', 'fs-observation-policy': 'workspace provider', 'attachment-local': 'native-attachments',
  'session-query-sqlite': 'native-query', 'storage': 'native-storage', 'storage-domain': 'native-storage',
  'typert': 'Remote dispatch', 'remote-access': 'native-environment', 'job-controller': 'native interaction',
  'terminal-controller': 'native interaction', 'workspace-files': 'native-files', 'session-controller': 'Weft session host',
  'cordis-host-runner': 'native-plugins', 'cordis-inspect-providers': 'native-plugins', 'plugin-inventory': 'native-composition',
  'skill': 'native interaction', 'settings-controller': 'environment settings', 'workspace-controller': 'native workspaces',
  'session-log-download': 'session reader', 'tool-working-directory': 'workspace provider', 'repeat-tool-reminder': 'preset catalog',
  'authorization': 'native-plugins', 'plugin-package-inventory-deepseek': 'native-composition',
  'cordis-client-runner': 'native-plugins (its browser module is in the Boot Graph)',
};

/** Node host providers and the Cloudflare implementation that serves each service. */
export const PLATFORM: Record<string, string> = {
  'session-persistence-jsonl': 'SessionDO SQLite persistence',
  'credentials': 'EnvironmentDO credentials', 'settings': 'EnvironmentDO settings', 'config-editor': 'EnvironmentDO settings (no document)',
  'storage-json': 'Durable Object storage',
  'subprocess': 'Computer execution backends', 'sandbox': 'Computer file observer policy', 'bash-sandbox': 'Computer file observer policy',
  'fs-sandbox': 'Computer workspace filesystem', 'directory-picker': 'native workspaces',
  'plugin-manager': 'native plugin management', 'hmr': 'immutable Worker deployment', 'typert-loader': 'generated Typert registry',
  'typert-gateway': 'Worker HTTP gateway', 'webserver': 'Worker HTTP gateway', 'web-runtime': 'Worker HTTP gateway',
  'web-startup': 'Worker HTTP gateway', 'connection': 'Worker HTTP gateway', 'api-remotes': 'Worker HTTP gateway',
  'modules': 'Boot Graph', 'client-hmr': 'immutable Worker deployment', 'file-upload': 'Worker HTTP gateway',
};

/** Rows with no role in a Web deployment. */
export const NOT_APPLICABLE: Record<string, string> = {
  'otel': 'telemetry export', 'session-telemetry-otel': 'telemetry export', 'desktop-product-telemetry': 'desktop telemetry',
  'open-in-app': 'desktop applications', 'harness-dev-context': 'harness development checkout', 'pwsh-sandbox': 'Windows PowerShell',
  'tool-pwsh': 'Windows PowerShell', 'tool-plugin-manager': 'disabled in the official profile',
};

/** Rows waiting for a Cloudflare service (see docs/architecture/external-services.md). */
export const EXTERNAL: Record<string, string> = {
  'office-to-pdf': 'LibreOffice Container', 'deepseek-account': 'platform OAuth callback', 'llm-deepseek-account': 'platform OAuth callback',
  'account-controller': 'platform OAuth callback', 'ptc-runtime': 'worker-javascript execution backend',
  'workspace-changes': 'container-shell git snapshots',
};

/** Rows whose Weft provider does not exist yet. */
export const PENDING: Record<string, string> = {
  'spill-local': 'spill storage over Durable Object or workspace storage',
  'spill-policy': 'needs spill storage',
  'session-projection-cache': 'projection checkpoint records in SessionDO storage',
  'mcp-resources': 'MCP client and server provisioning per environment',
};

/** Browser rows: served by the Boot Graph from the official client builds. */
export const isBrowserRow = (name: string) => /^@deepseek-ai\/dsh-client-/.test(name);

/**
 * Preset-level rows: disabled at the root by the official profile and enabled
 * by Agent presets, which Weft composes through the same Loader.
 */
export const PRESET_ROWS = new Set([
  'tool-bash', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'agent-instructions', 'skill-filesystem', 'tool-skill',
  'command-goal', 'plan-mode', 'compaction-basic', 'command-compact', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-result-pruner', 'tool-todo', 'tool-goal', 'tool-web',
]);

/** The overlay patches: every row not loaded is disabled, so the Loader composes only `LOADED` rows. */
export function overlayPatches(rows: readonly {id: string; name: string}[]): PatchOptions[] {
  return rows.filter(row => !Object.hasOwn(LOADED, row.id)).map(row => ({id: row.id, disabled: true}));
}
