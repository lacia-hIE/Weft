import {createHash, randomUUID} from 'node:crypto';

export type DynamicWorkerKind = 'plugin' | 'ptc' | 'workspace-javascript' | 'workspace-shell';
export interface WorkerObservation {
  kind: DynamicWorkerKind;
  tenantId?: string;
  environmentId?: string;
  sessionId?: string;
  workspaceId?: string;
  pluginId?: string;
  pluginVersion?: string;
  pluginScope?: 'environment' | 'session';
  resourceId?: string;
}
export interface WorkerObservationProps extends WorkerObservation {
  schemaVersion: 1;
  loaderMode: 'get' | 'load';
  workerId: string;
  codeHash?: string;
}
export interface TailContext { readonly exports: unknown }
type TailExports = {DynamicWorkerTail?: (options: {props: WorkerObservationProps}) => Fetcher};
const FIELDS = ['tenantId', 'environmentId', 'sessionId', 'workspaceId', 'pluginId', 'pluginVersion', 'resourceId'] as const;
// One definition revision for installing tails; no request IDs enter cached Worker identities.
const REVISION = 'weft-observed-v1:';

/** Only platform-owned identifiers cross into Tail props; no capabilities or guest data. */
export function observationScope(scope: object, kind: DynamicWorkerKind, extra: Partial<WorkerObservation> = {}): WorkerObservation {
  const input = {...scope, ...extra} as Record<string, unknown>;
  const result: WorkerObservation = {kind};
  for (const key of FIELDS) {const value = input[key]; if (typeof value === 'string' && value.length <= 256) result[key] = value;}
  if (result.tenantId && !result.environmentId) result.environmentId = 'default';
  if (input.pluginScope === 'environment' || input.pluginScope === 'session') result.pluginScope = input.pluginScope;
  return result;
}

/** Fingerprint module bytes, never env bindings, credentials or capability objects. */
function codeHash(code: WorkerLoaderWorkerCode): string | undefined {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([code.mainModule, code.compatibilityDate, code.compatibilityFlags ?? []]));
  for (const name of Object.keys(code.modules).sort()) {
    hash.update(JSON.stringify(name));
    const module = code.modules[name]!;
    if (typeof module === 'string') {hash.update(JSON.stringify(['source', module.length])); hash.update(module); continue;}
    if (module instanceof WebAssembly.Module) return undefined;
    for (const key of Object.keys(module).sort() as (keyof WorkerLoaderModule)[]) {
      const value = module[key];
      hash.update(key);
      if (value instanceof WebAssembly.Module) return undefined;
      if (value instanceof ArrayBuffer) hash.update(new Uint8Array(value));
      else if (ArrayBuffer.isView(value)) hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      else if (typeof value === 'string') {hash.update(JSON.stringify(value.length)); hash.update(value);}
      else hash.update(JSON.stringify(value) ?? 'undefined');
    }
  }
  return hash.digest('hex');
}

/** Adds one native Tail binding while preserving guest code, capabilities and loader semantics. */
export function observedLoader(loader: WorkerLoader | undefined, ctx: TailContext, scope: () => WorkerObservation): WorkerLoader | undefined {
  const tail = (ctx.exports as TailExports | undefined)?.DynamicWorkerTail;
  // Minimal fixtures and deployments without the exported collector keep their original loader.
  if (!loader || !tail) return loader;
  const tags = (): WorkerObservation => {
    const context = scope();
    return observationScope(context, context.kind);
  };
  const attach = (code: WorkerLoaderWorkerCode, loaderMode: 'get' | 'load', workerId: string, context: WorkerObservation): WorkerLoaderWorkerCode => {
    const digest = codeHash(code);
    const props: WorkerObservationProps = {schemaVersion: 1, ...context, loaderMode, workerId, ...(digest ? {codeHash: digest} : {})};
    return {...code, tails: [...code.tails ?? [], tail({props})]};
  };
  return {
    get(id, callback) {
      const context = tags();
      if (id === null) return loader.get(null, async () => attach(await callback(), 'load', 'load:' + randomUUID(), context));
      const key = REVISION + createHash('sha256').update(JSON.stringify([id, context])).digest('hex');
      return loader.get(key, async () => attach(await callback(), 'get', key, context));
    },
    load: code => loader.load(attach(code, 'load', 'load:' + randomUUID(), tags())),
  };
}
