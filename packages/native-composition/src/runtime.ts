import type {Context, Fiber} from '@deepseek-ai/cordis';
import type {PluginRuntimeEntry, RuntimePhase} from './runtime-contract.ts';

const phases: RuntimePhase[] = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];
const LIMIT = 2048;
const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ValidationError', 'AbortError', 'CordisError']);
const errorCodes = new Set(['INACTIVE_EFFECT', 'DUPLICATE_SERVICE', 'INVALID_CONFIG', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);
export function runtimeFailure(error: unknown): NonNullable<PluginRuntimeEntry['failure']> {
  const failure = error as {name?: unknown; code?: unknown} | undefined;
  const name = typeof failure?.name === 'string' && errorNames.has(failure.name) ? failure.name : 'Error';
  const code = typeof failure?.code === 'string' && errorCodes.has(failure.code) ? failure.code : undefined;
  return {kind: name === 'ValidationError' ? 'configuration' : 'startup', name, ...(code ? {code} : {})};
}

/** Public Fiber state only. Never export plugin config, arbitrary error text, stacks or credential values. */
async function describeFiber(fiber: Fiber, id: string, moduleName: string): Promise<PluginRuntimeEntry> {
  const phase = phases[fiber.state] ?? 'unavailable';
  const missingServices = Object.keys(fiber.inject).filter(name => {
    try {return fiber.ctx.get(name) === undefined;} catch {return true;}
  }).slice(0, 64);
  const row: PluginRuntimeEntry = {id, moduleName, phase, missingServices};
  if (fiber.parent.fiber.uid !== null && fiber.parent.fiber !== fiber) row.parentId = 'fiber:'+fiber.parent.fiber.uid;
  if (phase === 'failed') {
    try {await fiber.await();} catch (error) {
      row.failure = runtimeFailure(error);
    }
  }
  return row;
}

/** Inspect the owning world's existing Loader and registry; no imports, assembly or Agent activation. */
export async function readPluginRuntime(ctx: Context): Promise<{entries: PluginRuntimeEntry[]; truncated: boolean}> {
  const rows: PluginRuntimeEntry[] = [];
  const seen = new Set<Fiber>();
  const loader = ctx.get('loader');
  let total = 0;
  if (loader) for (const entry of loader.entries()) {
    if (entry.options.group) continue;
    total++;
    const fiber = entry.fiber;
    if (fiber) seen.add(fiber);
    if (rows.length >= LIMIT) continue;
    const row = fiber ? await describeFiber(fiber, fiber.uid === null ? 'entry:'+entry.id : 'fiber:'+fiber.uid, entry.options.name)
      : {id: 'entry:'+entry.id, moduleName: entry.options.name, phase: entry.disabled ? 'disabled' as const : 'unavailable' as const, missingServices: []};
    rows.push({...row, entryId: entry.id, ...(entry.disabled ? {phase: 'disabled' as const} : {})});
  }
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
    if (seen.has(fiber) || fiber.uid === null) continue;
    total++;
    if (rows.length >= LIMIT) continue;
    rows.push(await describeFiber(fiber, 'fiber:'+fiber.uid, runtime.name ?? runtime.callback.name ?? 'anonymous'));
  }
  return {entries: rows, truncated: total > LIMIT};
}
