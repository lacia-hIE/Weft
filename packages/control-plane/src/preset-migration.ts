import type { AgentSpec } from './contracts.ts';
/**
 * One preset revision's rows under DSH 0.2.2: `list_agents` joined the
 * subagent control plugin, and the subagent opt-in became `modelSelection`
 * plus `modelDiscovery`. Other rows are kept as published.
 */
export function migratePresetSpec(spec: AgentSpec): AgentSpec {
  const plugins = spec.plugins.filter(row => row.id !== 'tool-subagent-list-agents').map(row => {
    if ((row.id !== 'tool-subagent' && row.id !== 'tool-subagent-fork') || !Object.hasOwn(row.config, 'modelSelectionSettings')) return row;
    const {modelSelectionSettings, ...config} = row.config;
    return {...row, config: modelSelectionSettings === true ? {...config, modelSelection: true, modelDiscovery: true} : config};
  });
  return {...structuredClone(spec), plugins: structuredClone(plugins)};
}
