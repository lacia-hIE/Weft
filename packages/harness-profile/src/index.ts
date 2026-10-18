import {applyEntryPatches, type PatchOptions} from '@deepseek-ai/cordis-plugin-include';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import type {PresetDefinition} from '@deepseek-ai/dsh-agent-preset-registry';
import manifest from '../package.json';
import patch from '../cordis.patch.json';
import descriptor from '../profile.json';

/** A real bundled composition, with the same patch semantics as dsh profiles. */
export const profileManifest = manifest;
export const profileDescriptor = descriptor;
if (Object.entries(profileDescriptor.dependencies).find(([name]) => name === profileManifest.name)?.[1] !== profileManifest.version) throw new Error('Bundled profile dependency does not match the included package');
export const profileEntries: readonly EntryOptions[] = applyEntryPatches([], profileDescriptor.dsh.profile.bundles.includes(profileManifest.name) ? patch as PatchOptions[] : [], message => {throw new Error(message);});
export const profileDefinitions = profileEntries.map(entry => structuredClone(entry.config) as PresetDefinition);
export const presetEntryId = (id: string): string => 'preset-'+id;

export function profileEntry(definition: PresetDefinition, disabled = false): EntryOptions {
  const base = profileEntries.find(entry => entry.id === presetEntryId(definition.id));
  return {...base, id: presetEntryId(definition.id), name: 'cordis:agent-preset', config: structuredClone(definition), disabled};
}
