import { Context, Service } from '@deepseek-ai/cordis';
import pluginMeta from '../../../.generated/plugin-meta.json';
import { prebuiltPluginPackages } from '../../plugin-runtime/src/catalog.ts';

type LocalizedText = Record<string, string>;
interface PluginLocalizedMeta { title?: LocalizedText; description?: LocalizedText }
const packages = pluginMeta.packages as Record<string, PluginLocalizedMeta>;
const rows = pluginMeta.rows as Record<string, string>;

/**
 * The display metadata the original plugin inventory reads through
 * `pluginPackages.metaOf`. The original reads each package's `locale/*.json`
 * from disk; workerd reads the table the build collected from the same files.
 * Weft's prebuilt rows are named `cordis:<row id>`; their package is the one the
 * catalog names, else the one the official profile or preset row names.
 */
export class WorkerdPluginPackages extends Service {
  constructor(ctx: Context) { super(ctx, 'pluginPackages'); }
  metaOf(name: string, _base?: string): PluginLocalizedMeta | undefined {
    const id = name.startsWith('cordis:') ? name.slice(7) : undefined;
    const packageName = id === undefined ? name : prebuiltPluginPackages[id] ?? rows[id];
    const meta = packageName === undefined ? undefined : packages[packageName];
    return meta === undefined ? undefined : structuredClone(meta);
  }
}
