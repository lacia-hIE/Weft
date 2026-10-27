import {Context, type Fiber} from '@deepseek-ai/cordis';
import {NativePluginPlatform} from '../../native-plugins/src/platform.ts';
import type {Artifact, Installation} from './contracts.ts';

export const environmentFacetName = (name: string) => 'harness-plugin:environment:' + name;
const identity = (row: Installation) => JSON.stringify([row.digest, row.activationId, row.permissions, row.config ?? {}]);
export function installedServices(row: Installation): string[] {
  const p = row.permissions;
  return [...(p.files !== 'none' ? ['fs'] : []), ...(p.tools || row.hostScope==='environment' ? ['tools'] : []), ...(p.timer ? ['timer'] : []),
    ...(p.storage ? ['storage', 'storageDomain'] : []), ...(p.sessions ? ['sessionController','webhookRuntime'] : []), ...(p.credentials ? ['credentials'] : []), ...(p.routes ? ['webServer'] : [])];
}
interface Active {row: Installation; runId: string; fiber?: Fiber}
/** A single environment-owned activation, independent of open browser pages and Sessions. */
export class EnvironmentPackages {
  private readonly ctx = new Context();
  private readonly platform: NativePluginPlatform;
  private readonly active = new Map<string, Active>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly owner: {
    state: DurableObjectState; loader: WorkerLoader | undefined; scope: object;
    list(): Installation[]; artifact(name: string, digest: string): Promise<Artifact>;
    capability(row: Installation): Fetcher; failed(row: Installation): Promise<void>;
  }) {
    owner.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_plugin_facets (name TEXT PRIMARY KEY)');
    this.platform = new NativePluginPlatform(owner.state, owner.loader, owner.scope, pluginId => {
      const name = pluginId.slice('environment:'.length), row = this.active.get(name);
      if (!row) throw new Error('Background activation is no longer selected');
      return owner.capability(row.row);
    });
  }
  reconcile(): Promise<void> {
    const work = this.tail.catch(() => {}).then(async () => {
      if (this.closed) return;
      const selected = this.owner.list().filter(row => row.hostScope === 'environment' && row.approved && row.enabled && row.permissions.background);
      for (const [name, active] of this.active) if (!selected.some(row => row.name === name && identity(row) === identity(active.row))) await this.stopNow(name);
      for (const row of selected) {
        if (this.active.has(row.name)) continue;
        this.owner.state.storage.sql.exec('INSERT OR IGNORE INTO weft_environment_plugin_facets VALUES (?)', row.name);
        const active: Active = {row, runId: crypto.randomUUID()}; this.active.set(row.name, active);
        try {
          const artifact = await this.owner.artifact(row.name, row.digest);
          if (this.closed || this.active.get(row.name) !== active) continue;
          if (!artifact.host) {this.active.delete(row.name); continue;}
          // A cold supervisor must replace any surviving facet's capability receipt.
          this.owner.state.facets.abort(environmentFacetName(row.name), new Error('Background Host generation changed'));
          const plugin = await this.platform.evaluate(this.ctx, 'environment:' + row.name, active.runId, '', () => () => {}, {
            module: artifact.host, services: installedServices(row), environment: true, network: row.permissions.network === true, activationId: row.activationId ?? row.digest, ...(row.config ? {config: row.config} : {}),
          });
          if (this.closed || this.active.get(row.name) !== active) {await this.platform.release(active.runId); continue;}
          active.fiber = this.ctx.plugin(plugin); await active.fiber.await();
        } catch {
          await this.stopNow(row.name); await this.owner.failed(row);
        }
      }
    });
    this.tail = work; return work;
  }
  private async stopNow(name: string): Promise<void> {
    const active = this.active.get(name); if (!active) return; this.active.delete(name);
    await active.fiber?.dispose(); await this.platform.release(active.runId);
  }
  async stop(name: string): Promise<void> {
    // Revocation must not queue behind apply(), which may be waiting for a capability RPC.
    await this.stopNow(name);
  }
  async fetch(name: string, request: Request): Promise<Response> {
    await this.reconcile();
    const active = this.active.get(name);
    return active ? this.platform.fetch(active.runId, request) : new Response(null, {status:404});
  }
  private async activation(name:string,digest:string,activationId:string):Promise<Active> {
    await this.reconcile();const active=this.active.get(name);
    if(!active || active.row.digest!==digest || (active.row.activationId??active.row.digest)!==activationId)throw new Error('Background activation was revoked');
    return active;
  }
  async tools(name:string,digest:string,activationId:string) {return this.platform.toolMetadata((await this.activation(name,digest,activationId)).runId);}
  async tool(name:string,digest:string,activationId:string,tool:string,args:unknown,callId:string,operationId:string) {
    return this.platform.tool((await this.activation(name,digest,activationId)).runId,tool,args,callId,operationId);
  }
  async cancelTool(name:string,digest:string,activationId:string,operationId:string):Promise<void> {
    const active=this.active.get(name);
    if(active && active.row.digest===digest && (active.row.activationId??active.row.digest)===activationId)await this.platform.cancelTool(active.runId,operationId);
  }
  async dispatchWebhook(delivery:unknown):Promise<void> {
    await this.reconcile();
    const results=await Promise.allSettled([...this.active.values()].filter(active=>active.row.permissions.sessions).map(active=>this.platform.deliverWebhook(active.runId,delivery)));
    if(results.some(result=>result.status==='rejected'))throw new Error('A Worker webhook receiver is unavailable');
  }
  async tick(): Promise<void> {
    await this.reconcile();
    for (const active of this.active.values()) {
      try {await this.platform.tick(active.runId);} catch {await this.stopNow(active.row.name); await this.owner.failed(active.row);}
    }
  }
  /** Whether an active Host may hold connections that end with this object's eviction. */
  networked(): boolean {return [...this.active.values()].some(active => active.row.permissions.network === true);}
  async nextAlarm(): Promise<number | undefined> {
    const values = await Promise.all([...this.active.values()].map(active => this.platform.nextAlarm(active.runId)));
    const due = values.filter((value): value is number => value !== undefined);
    return due.length ? Math.min(...due) : undefined;
  }
  async dispose(): Promise<void> {this.closed = true; for (const name of [...this.active.keys()]) await this.stopNow(name); await this.ctx.fiber.dispose();}
}
