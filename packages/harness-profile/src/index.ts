import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import type {PresetDefinition} from '@deepseek-ai/dsh-agent-preset-registry';
import manifest from '../package.json';
import {weftPresetDefinitions} from './presets.ts';
import descriptor from '../profile.json';

/** A real bundled composition, with the same patch semantics as dsh profiles. */
export const profileManifest = manifest;
export const profileDescriptor = descriptor;
if (Object.entries(profileDescriptor.dependencies).find(([name]) => name === profileManifest.name)?.[1] !== profileManifest.version) throw new Error('Bundled profile dependency does not match the included package');
export const presetEntryId = (id: string): string => 'preset-'+id;
/** The official Web presets, one Loader row each, as the bundled profile ships them. */
export const profileDefinitions: readonly PresetDefinition[] = profileDescriptor.dsh.profile.bundles.includes(profileManifest.name) ? weftPresetDefinitions : [];
export const profileEntries: readonly EntryOptions[] = profileDefinitions.map(definition => ({id: presetEntryId(definition.id), name: 'cordis:agent-preset', config: structuredClone(definition)}));

export function profileEntry(definition: PresetDefinition, disabled = false): EntryOptions {
  const base = profileEntries.find(entry => entry.id === presetEntryId(definition.id));
  return {...base, id: presetEntryId(definition.id), name: 'cordis:agent-preset', config: structuredClone(definition), disabled};
}
