import worker, {DynamicWorkerTail as BaseTail, type Env as BaseEnv} from '../../apps/worker/src/index.ts';
import {DurableObject} from 'cloudflare:workers';
import type {DynamicWorkerUsage} from '../../packages/dynamic-worker-observability/src/tail.ts';
import {observedLoader, observationScope} from '../../packages/dynamic-worker-observability/src/loader.ts';
import {workspaceAddress, type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
export * from '../../apps/worker/src/index.ts';

interface Env extends BaseEnv {
  USAGE: DurableObjectNamespace<Usage>;
  OBSERVATION_BENCH: DurableObjectNamespace<ObservationBench>;
}
export class Usage extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {super(ctx, env); ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage(value TEXT NOT NULL)');}
  append(value: DynamicWorkerUsage): void {this.ctx.storage.sql.exec('INSERT INTO usage VALUES (?)', JSON.stringify(value));}
  list(): DynamicWorkerUsage[] {return this.ctx.storage.sql.exec<{value: string}>('SELECT value FROM usage').toArray().map(row => JSON.parse(row.value));}
}
/** A private CI sink observes the production handler's exact records without a production database. */
export class DynamicWorkerTail extends BaseTail {
  protected override record(value: DynamicWorkerUsage): void {
    this.ctx.waitUntil(Promise.resolve((this.env as Env).USAGE.getByName('all').append(value)));
  }
}
const guest = `import {WorkerEntrypoint,DurableObject} from 'cloudflare:workers';
export default class extends WorkerEntrypoint {ping(){console.log('GUEST_SECRET');return 42;} fail(){throw new Error('EXCEPTION_SECRET');}}
export class Facet extends DurableObject {ping(){console.log('FACET_SECRET');return 42;}}`;
export class ObservationBench extends DurableObject<Env> {
  async run(input: {tenantId: string; environmentId: string; mode: 'get' | 'load' | 'facet'}): Promise<number> {
    const loader = observedLoader(this.env.LOADER, this.ctx, () => observationScope(input, 'plugin', {pluginId: 'fixture', resourceId: this.ctx.id.toString()}))!;
    const code = () => ({compatibilityDate: '2026-07-30', mainModule: 'main.js', modules: {'main.js': guest}, globalOutbound: null});
    const loaded = input.mode === 'load' ? loader.load(code()) : loader.get('fixture-code-v1', code);
    if (input.mode === 'facet') {
      const facet = this.ctx.facets.get('observed', () => ({class: loaded.getDurableObjectClass('Facet')})) as unknown as {ping(): Promise<number>};
      return facet.ping();
    }
    const entry = loaded.getEntrypoint() as unknown as {ping(): Promise<number>; fail(): Promise<void>};
    const value = await entry.ping();
    if (input.mode === 'load') try {await entry.fail();} catch {/* The Tail must retain exception metrics without its payload. */}
    return value;
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/_test/usage') return Response.json(await env.USAGE.getByName('all').list());
    if (path === '/_test/observe') {
      const input = await request.json() as {tenantId: string; environmentId: string; mode: 'get' | 'load' | 'facet'};
      return Response.json(await env.OBSERVATION_BENCH.getByName(JSON.stringify([input.tenantId, input.environmentId])).run(input));
    }
    if (path === '/_test/javascript') {
      const {scope, operation} = await request.json() as {scope: WorkspaceScope; operation: unknown};
      return env.WORKSPACES.getByName(workspaceAddress(scope)).javascript(scope, 'fixture-owner', operation);
    }
    if (path === '/_test/shell') {
      const {scope} = await request.json() as {scope: WorkspaceScope};
      const result = await env.WORKSPACES.getByName(workspaceAddress(scope)).exec(scope, {id: crypto.randomUUID(), command: 'printf OBSERVED_SHELL', cwd: '/workspace', timeoutMs: 5000});
      return Response.json({status: result.status, output: await result.text()});
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
