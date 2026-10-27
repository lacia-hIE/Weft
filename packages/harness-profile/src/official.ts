import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import bundles from '../../../.generated/official-bundles.json';
import { EXTERNAL, LOADED, MOUNTED_BY_WEFT, NOT_APPLICABLE, PENDING, PLATFORM, PRESET_ROWS, isBrowserRow, overlayPatches } from './overlay.ts';
import {MANAGEABLE_PROFILE_ROWS} from './management.ts';

const fail = (message: string, ...args: unknown[]) => { throw new Error(`Official profile patch failed: ${message} ${args.join(' ')}`); };

/** The official Web profile as the original Host composes it: the `base` and `web-app` bundle patches. */
export const officialProfile: readonly EntryOptions[] = applyEntryPatches([], [...bundles.base, ...bundles['web-app']] as PatchOptions[], fail);

/** Every entry, nested group rows included, with the path of groups above it. */
export function walkEntries(entries: readonly EntryOptions[], visit: (entry: EntryOptions, groups: readonly string[]) => void, groups: readonly string[] = []): void {
  for (const entry of entries) {
    visit(entry, groups);
    if (entry.group && Array.isArray(entry.config)) walkEntries(entry.config as EntryOptions[], visit, [...groups, entry.id]);
  }
}

const rows: {id: string; name: string}[] = [];
walkEntries(officialProfile, entry => rows.push({id: entry.id, name: entry.name}));

/** The profile after Weft's overlay: only `LOADED` rows stay enabled. */
export const officialEntries: readonly EntryOptions[] = applyEntryPatches(officialProfile as EntryOptions[], overlayPatches(rows), fail);

const isExpression = (value: unknown): boolean => value !== null && typeof value === 'object' && '__jsExpr' in value;
function containsExpression(value: unknown): boolean {
  if (isExpression(value)) return true;
  if (Array.isArray(value)) return value.some(containsExpression);
  return value !== null && typeof value === 'object' && Object.values(value).some(containsExpression);
}

/** Enabled rows; a disabled group disables its rows. */
export function enabledEntries(entries: readonly EntryOptions[] = officialEntries): EntryOptions[] {
  const off = new Set<string>();
  const enabled: EntryOptions[] = [];
  walkEntries(entries, (entry, groups) => {
    if (entry.disabled === true || groups.some(id => off.has(id))) { off.add(entry.id); return; }
    enabled.push(entry);
  });
  return enabled;
}

/**
 * The overlay's invariants, checked when the build composes the profile:
 * every host row is classified exactly once, every table names real rows,
 * and no enabled row keeps a `!!js` expression (workerd evaluates no dynamic code).
 * @returns the problems found; empty when the overlay is complete.
 */
export function overlayProblems(): string[] {
  const problems: string[] = [];
  for (const id of MANAGEABLE_PROFILE_ROWS) if (LOADED[id]?.phase !== 'late') problems.push(`Manageable row ${id} must be an optional late-loaded policy`);
  const tables = {LOADED, MOUNTED_BY_WEFT, PLATFORM, NOT_APPLICABLE, EXTERNAL, PENDING} as Record<string, Record<string, unknown>>;
  const known = new Set(rows.map(row => row.id));
  for (const [table, entries] of Object.entries(tables)) for (const id of Object.keys(entries)) if (!known.has(id)) problems.push(`${table} names ${id}, which the official profile no longer has`);
  for (const id of PRESET_ROWS) if (!known.has(id)) problems.push(`PRESET_ROWS names ${id}, which the official profile no longer has`);
  for (const row of rows) {
    if (isBrowserRow(row.name) || PRESET_ROWS.has(row.id)) continue;
    const homes = Object.entries(tables).filter(([, entries]) => Object.hasOwn(entries, row.id)).map(([table]) => table);
    if (homes.length !== 1) problems.push(`${row.id} (${row.name}) is classified ${homes.length ? homes.join(', ') : 'nowhere'}`);
  }
  for (const entry of enabledEntries()) {
    if (isExpression(entry.disabled) || containsExpression(entry.config)) problems.push(`${entry.id} stays enabled with a !!js expression`);
  }
  return problems;
}

/** Package specifiers the enabled rows load; the build bundles exactly these modules. */
/** Original modules a Session creates entries of from environment configuration, not from a profile row. */
export const CONFIGURED_MODULES = ['@deepseek-ai/dsh-mcp-client'];
export function enabledModuleNames(): string[] {
  return [...new Set([...enabledEntries().map(entry => entry.name), ...CONFIGURED_MODULES])].sort();
}
