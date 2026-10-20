import type { Context } from '@deepseek-ai/cordis';
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import officialModules from 'weft:official-modules';
import { enabledEntries } from '../../harness-profile/src/official.ts';

/** Real Loader tree over modules included in this Worker, without disk imports. */
export class WorkerdLoader extends Loader {
  override write(): void { /* The environment owns immutable profile snapshots. */ }
  override import(name: string): unknown {
    if (name.startsWith('cordis:') && Object.hasOwn(this.builtins, name.slice(7))) return this.builtins[name.slice(7)];
    if (Object.hasOwn(officialModules, name)) return officialModules[name];
    throw new Error('Plugin is not in the prebuilt workerd catalog: '+name);
  }
}

/**
 * The world's one Loader. Root profile entries and preset compositions share
 * it, as they share one Loader tree in the original Host.
 * @returns the Loader with the given prebuilt modules registered.
 */
export async function workerdLoader(ctx: Context, modules: Record<string, unknown> = {}): Promise<Loader> {
  if (!ctx.get('loader')) await ctx.plugin(WorkerdLoader, {baseUrl: 'https://weft.invalid/prebuilt/'});
  const loader = ctx.loader;
  for (const [id, module] of Object.entries(modules)) {
    if (Object.hasOwn(loader.builtins, id) && loader.builtins[id] !== module) throw new Error('Prebuilt module id is registered twice: '+id);
    loader.builtins[id] = module;
  }
  return loader;
}

/** Create one profile entry and wait until its fiber is active. */
export async function createEntry(loader: Loader, entry: EntryOptions): Promise<void> {
  await loader.create(entry);
  await loader.resolve(entry.id).fiber?.await();
}

/**
 * Create the official profile's enabled rows in this world's Loader. Rows the
 * overlay disables are served by Weft providers under the same ids, so they are
 * not created here. Each row activates once the services it injects are
 * present, as in the original Host; rows whose services this world never
 * provides stay pending.
 */
export async function mountOfficialProfile(ctx: Context): Promise<void> {
  const loader = await workerdLoader(ctx);
  for (const entry of enabledEntries()) await loader.create(structuredClone(entry));
}
