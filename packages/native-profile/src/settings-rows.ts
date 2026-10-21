import type Schema from '@deepseek-ai/schemastery';
import officialModules from 'weft:official-modules';
import { volatileForm } from '@weft/upstream/packages/settings/settings/src/schema.ts';
import { enabledEntries } from '../../harness-profile/src/official.ts';
import { LOADED } from '../../harness-profile/src/overlay.ts';

/** One profile row the official settings forms can edit: its id, plugin schema and profile configuration. */
export interface ProfileSettingRow { id: string; schema: Schema; base: Record<string, unknown> }

function schemaOf(module: unknown): Schema | undefined {
  const plugin = module as {Config?: Schema; default?: {Config?: Schema}} | undefined;
  return plugin?.Config ?? plugin?.default?.Config;
}

/**
 * The Loader-loaded profile rows whose plugin schema declares live fields, as
 * the official settings forms find them in the composed profile. An
 * environment's edits to them are configuration overrides of these rows.
 */
export const profileSettingRows: readonly ProfileSettingRow[] = enabledEntries()
  .filter(entry => Object.hasOwn(LOADED, entry.id))
  .flatMap(entry => {
    const schema = schemaOf(officialModules[entry.name]);
    return schema !== undefined && volatileForm(schema) !== undefined
      ? [{id: entry.id, schema, base: structuredClone((entry.config ?? {}) as Record<string, unknown>)}]
      : [];
  });
