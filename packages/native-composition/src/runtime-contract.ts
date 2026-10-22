export type RuntimePhase = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'disabled' | 'unavailable';
export interface PluginRuntimeEntry {
  id: string;
  moduleName: string;
  entryId?: string;
  parentId?: string;
  phase: RuntimePhase;
  missingServices: string[];
  failure?: {kind: 'configuration' | 'startup'; name: string; code?: string};
}
export interface PluginRuntimeSnapshot {
  observedAt: number;
  sessionId: string;
  state: 'active' | 'inactive' | 'missing' | 'loading' | 'failed';
  failure?: {kind: 'configuration' | 'startup'; name: string; code?: string};
  entries: PluginRuntimeEntry[];
  truncated: boolean;
}
