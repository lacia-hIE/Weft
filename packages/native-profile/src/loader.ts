import type { Context } from '@deepseek-ai/cordis';
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import officialModules from 'weft:official-modules';
import { enabledEntries } from '../../harness-profile/src/official.ts';
import { LOADED, type ProfilePhase } from '../../harness-profile/src/overlay.ts';
import { PRESET_PENDING } from '../../harness-profile/src/presets.ts';

/** The base URL of prebuilt rows; nothing is fetched from it. */
const PREBUILT_BASE = 'https://weft.invalid/prebuilt/';

/** Real Loader tree over modules included in this Worker, without disk imports. */
export class WorkerdLoader extends Loader {
  override write(): void { /* The environment owns immutable profile snapshots. */ }
  override import(name: string): unknown {
    if (name.startsWith('cordis:') && Object.hasOwn(this.builtins, name.slice(7))) return this.builtins[name.slice(7)];
    if (Object.hasOwn(officialModules, name)) return officialModules[name];
    const pending = name.startsWith('cordis:') ? PRESET_PENDING[name.slice(7)] : undefined;
    if (pending) throw new Error(`Needs ${pending}, which this deployment does not provide yet`);
    throw new Error('Plugin is not in the prebuilt workerd catalog: '+name);
  }
}

/**
 * The world's one Loader. Root profile entries and preset compositions share
 * it, as they share one Loader tree in the original Host.
 * @returns the Loader with the given prebuilt modules registered.
 */
export async function workerdLoader(ctx: Context, modules: Record<string, unknown> = {}): Promise<Loader> {
  if (!ctx.get('loader')) {
    await ctx.plugin(WorkerdLoader, {baseUrl: PREBUILT_BASE});
    // The Loader sets the base on its own context; root readers (the plugin inventory) look it up on the root.
    ctx.baseUrl ??= PREBUILT_BASE;
  }
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
 * Create the official profile's enabled rows of one phase in this world's
 * Loader. `core` and `agents` rows are created in the overlay's order and awaited, so the
 * world can build on their services; `late` rows activate once the services
 * they inject exist, as in the original Host, and rows whose services this
 * world never provides stay pending. Rows the overlay disables are served by
 * Weft providers under the same ids, so they are not created here.
 */
export async function mountOfficialProfile(ctx: Context, phase: ProfilePhase, native: boolean, overrides: ProfileOverrides = {}): Promise<void> {
  const loader = await workerdLoader(ctx);
  const rows = new Map(enabledEntries().map(entry => [entry.id, entry]));
  for (const [id, row] of Object.entries(LOADED)) {
    if (row.phase !== phase || (row.native && !native)) continue;
    const entry = rows.get(id);
    if (!entry) throw new Error(`Official profile row ${id} is not enabled`);
    const options = {...structuredClone(entry), ...(Object.hasOwn(overrides, id) ? {config: structuredClone(overrides[id])} : {})};
    if (phase !== 'late') await createEntry(loader, options);
    else await loader.create(options);
  }
}

/** An environment's configuration for profile rows, by row id; a row's value replaces its profile configuration. */
export type ProfileOverrides = Record<string, Record<string, unknown>>;

/**
 * Apply an environment's changed row configuration to a live world through
 * the Loader, as a profile patch reconciles: live fields update in place and
 * other fields restart the row.
 * @returns the configuration now applied.
 */
export async function reconcileProfileOverrides(ctx: Context, applied: ProfileOverrides, next: ProfileOverrides): Promise<ProfileOverrides> {
  const rows = new Map(enabledEntries().map(entry => [entry.id, entry]));
  for (const id of new Set([...Object.keys(applied), ...Object.keys(next)])) {
    if (JSON.stringify(applied[id]) === JSON.stringify(next[id]) || ![...ctx.loader.entries()].some(entry => entry.options.id === id)) continue;
    await ctx.loader.update(id, {config: structuredClone(next[id] ?? (rows.get(id)?.config as Record<string, unknown> | undefined) ?? {})});
  }
  return structuredClone(next);
}
