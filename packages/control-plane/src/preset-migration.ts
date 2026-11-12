import type { AgentSpec } from './contracts.ts';

/** Rows the former optional Agent Teams bundle added; DSH 0.2.2-rc.2 composes Teams at the root. */
const TEAM_ROWS = new Set(['agent-team', 'tool-agent-team', 'ui-agent-team']);

/**
 * One preset revision's rows under DSH 0.2.2: `list_agents` joined the
 * subagent control plugin, the subagent opt-in became `modelSelection`
 * plus `modelDiscovery`, and Agent Teams moved out of presets into the
 * official base composition. Other rows are kept as published.
 */
export function migratePresetSpec(spec: AgentSpec): AgentSpec {
  const plugins = spec.plugins.filter(row => row.id !== 'tool-subagent-list-agents' && !TEAM_ROWS.has(row.id)).map(row => {
    if ((row.id !== 'tool-subagent' && row.id !== 'tool-subagent-fork') || !Object.hasOwn(row.config, 'modelSelectionSettings')) return row;
    const {modelSelectionSettings, ...config} = row.config;
    return {...row, config: modelSelectionSettings === true ? {...config, modelSelection: true, modelDiscovery: true} : config};
  });
  return {...structuredClone(spec), plugins: structuredClone(plugins)};
}
