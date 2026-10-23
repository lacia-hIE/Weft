import type Loader from '@deepseek-ai/cordis-plugin-loader';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import type {PluginDriver} from './lifecycle.ts';

/** One native Loader update path for profile rows and registered extension plugins. */
export async function updateLoaderEntry(loader: Loader, options: EntryOptions): Promise<void> {
  const entry = [...loader.entries()].find(entry => entry.options.id === options.id);
  if (!entry) {
    await loader.create(options);
  } else {
    if (entry.options.name !== options.name) throw new Error('An existing Loader entry has a different module: '+options.id);
    const fiber = entry.fiber;
    await loader.update(options.id, {config: options.config, disabled: options.disabled ?? false});
    if (options.disabled) await fiber?.dispose();
  }
  if (!options.disabled) await loader.resolve(options.id).fiber?.await();
}
export function loaderDriver(loader: Loader): PluginDriver {
  return {
    apply: entry => updateLoaderEntry(loader, {id: entry.id, name: entry.name, config: entry.config, disabled: entry.disabled}),
    remove: async entry => {
      const current = [...loader.entries()].find(row => row.options.id === entry.id);
      if (!current) return;
      await current.fiber?.dispose(); loader.remove(entry.id);
    },
  };
}
