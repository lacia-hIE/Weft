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

/** When a Session world creates a loaded row. */
export type ProfilePhase = 'core' | 'agents' | 'late';

/**
 * Rows loaded from the profile. `core` and `agents` rows are created in this
 * order, each awaited before the next, because the rest of the Session world
 * builds on their services; `agents` rows follow the Weft-mounted system prompt
 * they inject. `late` rows are created after the world and activate once the
 * services they inject exist. `native` rows serve the official client and load
 * only in native Sessions, not in the v1 kernel API's Sessions.
 */
export const LOADED: Record<string, {world: 'session'; phase: ProfilePhase; native?: true}> = {
  'llm': {world: 'session', phase: 'core'},
  'session': {world: 'session', phase: 'core'},
  'session-projection': {world: 'session', phase: 'core'},
  'token-meter': {world: 'session', phase: 'core'},
  'commands': {world: 'session', phase: 'core'},
  'user-questions': {world: 'session', phase: 'core'},
  'subagent-model-selection-settings': {world: 'session', phase: 'core'},
  'tools': {world: 'session', phase: 'agents'},
  'agent': {world: 'session', phase: 'agents'},
  'goal': {world: 'session', phase: 'agents'},
  'goal-round-driver': {world: 'session', phase: 'agents'},
  'timer': {world: 'session', phase: 'late'},
  'llm-retry': {world: 'session', phase: 'late'},
  'deepseek-llm-api-extensions': {world: 'session', phase: 'late'},
  'session-log-deepseek': {world: 'session', phase: 'late'},
  'session-title-llm': {world: 'session', phase: 'late'},
  'timeout-policy': {world: 'session', phase: 'late'},
  'session-checkpoint-policy': {world: 'session', phase: 'late'},
  'image-offload': {world: 'session', phase: 'late'},
  'session-stats': {world: 'session', phase: 'late'},
  'session-turn-outline': {world: 'session', phase: 'late'},
  'message-feedback': {world: 'session', phase: 'late', native: true},
  'command-feedback': {world: 'session', phase: 'late', native: true},
  'web': {world: 'session', phase: 'late', native: true},
  'web-fetch-http': {world: 'session', phase: 'late', native: true},
  // Its base URL follows the environment's DeepSeek endpoint through the environment's row configuration.
  'web-search-deepseek': {world: 'session', phase: 'late', native: true},
  'repeat-tool-reminder': {world: 'session', phase: 'late', native: true},
  'spill-policy': {world: 'session', phase: 'late', native: true},
};

/** Original packages that Weft's world setup mounts today. */
export const MOUNTED_BY_WEFT: Record<string, string> = {
  'session-title': 'harness-runtime root (presentation Sessions only)',
  'system-prompt': 'harness-runtime root (per-Agent persona prefix)', 'agent-loop': 'harness-runtime root (environment loop settings)',
  'agent-preset-registry': 'native-composition', 'llm-deepseek': 'native-models', 'llm-pi-ai': 'native-models',
  'agent-default-model': 'environment settings', 'jobs': 'workspace shell', 'shell-env': 'workspace shell',
  'sandbox-policy': 'workspace shell', 'approval': 'native permissions', 'permission': 'native permissions',
  'subagent': 'native-subagents', 'subagent-spawn-in-process': 'native-subagents', 'subagent-fork-in-process': 'native-subagents',
  'schedule': 'native-schedule',
  'session-reference': 'native interaction', 'file-reference-local': 'native-files', 'working-directory': 'workspace provider',
  'workspace': 'native workspaces', 'fs-observation-policy': 'workspace provider', 'attachment-local': 'native-attachments',
  'session-query-sqlite': 'native-query', 'storage': 'native-storage', 'storage-domain': 'native-storage',
  'typert': 'Remote dispatch', 'remote-access': 'native-environment',
  // Mounted once the workspace shell exists: created as Loader rows they activate later and republish blank Session summaries.
  'job-controller': 'native interaction', 'terminal-controller': 'native interaction',
  'workspace-files': 'native-files', 'session-controller': 'Weft session host',
  'cordis-host-runner': 'native-plugins', 'cordis-inspect-providers': 'native-plugins', 'plugin-inventory': 'native-composition',
  'skill': 'native interaction', 'settings-controller': 'environment settings', 'workspace-controller': 'native workspaces',
  'session-log-download': 'session reader', 'tool-working-directory': 'workspace provider',
  // Its git snapshots run in the workspace container, so it is mounted only while the environment uses the container shell.
  'workspace-changes': 'workspace changes (container shell)',
  'spill-local': 'workspace spill store (packages/workspace/src/spill.ts)',
  'authorization': 'native-plugins', 'plugin-package-inventory-deepseek': 'native-composition',
  'cordis-client-runner': 'native-plugins (its browser module is in the Boot Graph)',
};

/** Node host providers and the Cloudflare implementation that serves each service. */
export const PLATFORM: Record<string, string> = {
  'session-persistence-jsonl': 'SessionDO SQLite persistence',
  'credentials': 'EnvironmentDO credentials', 'settings': 'EnvironmentDO settings', 'config-editor': 'EnvironmentDO settings (no document)',
  'storage-json': 'Durable Object storage', 'ptc-runtime': 'per-run Dynamic Worker PTC runtime',
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
  'account-controller': 'platform OAuth callback',
};

/** Rows whose Weft provider does not exist yet. */
export const PENDING: Record<string, string> = {
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

/**
 * Deployment facts for `!!js` expressions on loaded rows: workerd evaluates no
 * dynamic code, so each expression is replaced by the value it has in a Weft
 * deployment, with that reason.
 */
export const RESOLVED_CONFIG: Record<string, {config: Record<string, unknown>; reason: string}> = {
  'tools': {config: {}, reason: 'DSH_TOOLS_MODE is not set in Workers, so the tool mode keeps its default'},
};

/** The overlay patches: loaded rows take their resolved configuration; every other row is disabled. */
export function overlayPatches(rows: readonly {id: string; name: string}[]): PatchOptions[] {
  return rows.flatMap((row): PatchOptions[] => !Object.hasOwn(LOADED, row.id) ? [{id: row.id, disabled: true}]
    : Object.hasOwn(RESOLVED_CONFIG, row.id) ? [{id: row.id, config: structuredClone(RESOLVED_CONFIG[row.id]!.config)}] : []);
}
