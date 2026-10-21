import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import officialPresets from '../../../.generated/official-presets.json';

/**
 * The official Web presets (standard, ptc, minimal, cordis) as Weft composes
 * them. Each official row runs as the prebuilt row of the same id
 * (`cordis:<id>`) with the official configuration, unless one table below
 * says otherwise. A unit test checks every official row is either prebuilt or
 * listed, so an upstream preset change cannot be silently dropped.
 */

/** Rows whose capability a Weft provider already supplies to every Session. */
export const PRESET_PROVIDED: Record<string, string> = {
  'tool-fs': 'the Computer workspace provider registers the original file tools',
  'skill-filesystem': 'tool-skill loads Skills from the environment workspace',
  'tool-cordis': 'native Cordis plugin authoring, enabled for presets that allow client plugins',
};

/**
 * Rows that need a Weft provider not yet available. In a preset where they
 * are optional tools they are left out; where the preset exists for them
 * (`ESSENTIAL_PENDING`) they stay, and the registry reports the preset as
 * unavailable until the provider lands.
 */
export const PRESET_PENDING: Record<string, string> = {
  'tool-fs-search': 'ripgrep on the container-shell execution backend',
};

/** Pending rows a preset cannot do without. */
const ESSENTIAL_PENDING = new Set<string>();

/**
 * Deployment facts for the official rows' `disabled` expressions; workerd
 * evaluates no dynamic code. Workers run on Linux without a desktop profile.
 */
const DISABLED_FACTS: Record<string, boolean> = {
  "process.platform === 'win32'": false,
  "process.platform !== 'win32'": true,
  "!ctx.get('profileContext')": true,
};

interface OfficialRow { id: string; name: string; group?: boolean; disabled?: boolean | {__jsExpr: string}; config?: unknown; isolate?: unknown }
interface OfficialPreset { id: string; order?: number; plugins: OfficialRow[] }

function disabledOf(row: OfficialRow): boolean {
  if (row.disabled === undefined || typeof row.disabled === 'boolean') return row.disabled === true;
  const fact = DISABLED_FACTS[row.disabled.__jsExpr];
  if (fact === undefined) throw new Error(`Official preset row ${row.id} has an unresolved condition: ${row.disabled.__jsExpr}`);
  return fact;
}

/** One official row as the rows Weft composes in its place. */
function rows(row: OfficialRow, preset: OfficialPreset): PresetDefinition['plugins'] {
  if (disabledOf(row)) return [];
  // Weft stores a preset's rows flat; composition regroups the official planning and compaction realms.
  if (row.group) return (row.config as OfficialRow[]).flatMap(member => rows(member, preset));
  if (Object.hasOwn(PRESET_PROVIDED, row.id)) return [];
  if (Object.hasOwn(PRESET_PENDING, row.id) && !ESSENTIAL_PENDING.has(row.id)) return [];
  return [{id: row.id, name: 'cordis:'+row.id, ...(row.config === undefined ? {} : {config: structuredClone(row.config) as Record<string, unknown>})}];
}

/** Every official row of every preset, groups expanded, for the classification check. */
export function officialPresetRows(): {preset: string; id: string; name: string}[] {
  const out: {preset: string; id: string; name: string}[] = [];
  const walk = (preset: string, list: OfficialRow[]) => {
    for (const row of list) {
      if (row.group) walk(preset, row.config as OfficialRow[]);
      else if (!disabledOf(row)) out.push({preset, id: row.id, name: row.name});
    }
  };
  for (const preset of officialPresets as OfficialPreset[]) walk(preset.id, preset.plugins);
  return out;
}

/**
 * The official presets as Weft preset definitions. Names stay unset so the
 * client shows its localized official names and descriptions.
 */
export const weftPresetDefinitions: readonly PresetDefinition[] = (officialPresets as OfficialPreset[]).map(preset => ({
  id: preset.id,
  ...(preset.order === undefined ? {} : {order: preset.order}),
  plugins: preset.plugins.flatMap(row => rows(row, preset)),
}));
