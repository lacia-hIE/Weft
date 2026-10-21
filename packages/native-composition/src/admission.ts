import type { Context } from '@deepseek-ai/cordis';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import { PRESET_PENDING } from '../../harness-profile/src/presets.ts';

/** Admission for pinned, prebuilt modules; never run configuration as source. */
export function prepareProfileEntries(ctx: Context, entries: readonly EntryOptions[]): EntryOptions[] {
  const rows = structuredClone([...entries]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('__jsExpr' in value) throw new Error('JavaScript configuration expressions are not supported by the workerd host');
    for (const child of Object.values(value)) visit(child);
  };
  visit(rows);
  const check = (entries: readonly EntryOptions[]): void => {
    for (const row of entries) {
      // A disabled row is never imported; the inventory still lists it.
      if (row.disabled === true) continue;
      if (!row.name.startsWith('cordis:') || !Object.hasOwn(ctx.loader.builtins, row.name.slice(7))) {
        const pending = row.name.startsWith('cordis:') ? PRESET_PENDING[row.name.slice(7)] : undefined;
        throw new Error(pending ? `Needs ${pending}, which this deployment does not provide yet` : 'Plugin is not in the prebuilt workerd catalog: '+row.name);
      }
      if (row.group) {
        if (!Array.isArray(row.config)) throw new Error('Plugin group requires an entry list');
        check(row.config as EntryOptions[]);
      }
    }
  };
  check(rows);
  return rows;
}
