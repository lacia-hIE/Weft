import type { Context } from '@deepseek-ai/cordis';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

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
      if (!row.name.startsWith('cordis:') || !Object.hasOwn(ctx.loader.builtins, row.name.slice(7))) throw new Error('Plugin is not in the prebuilt workerd catalog: '+row.name);
      if (row.group) {
        if (!Array.isArray(row.config)) throw new Error('Plugin group requires an entry list');
        check(row.config as EntryOptions[]);
      }
    }
  };
  check(rows);
  return rows;
}
