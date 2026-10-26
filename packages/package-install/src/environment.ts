import {Context, type Fiber} from '@deepseek-ai/cordis';
import {NativePluginPlatform} from '../../native-plugins/src/platform.ts';
import type {Artifact, Installation} from './contracts.ts';

export const environmentFacetName = (name: string) => 'harness-plugin:environment:' + name;
const identity = (row: Installation) => JSON.stringify([row.digest, row.activationId, row.permissions]);
export function installedServices(row: Installation): string[] {
  const p = row.permissions;
  return [...(p.files !== 'none' ? ['fs'] : []), ...(p.tools ? ['tools'] : []), ...(p.timer ? ['timer'] : []),
    ...(p.storage ? ['storage', 'storageDomain'] : []), ...(p.sessions ? ['sessionController'] : []), ...(p.credentials ? ['credentials'] : []), ...(p.routes ? ['webServer'] : [])];
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
          if (!artifact.host) {this.active.delete(row.name); continue;}
          // A cold supervisor must replace any surviving facet's capability receipt.
          this.owner.state.facets.abort(environmentFacetName(row.name), new Error('Background Host generation changed'));
          const plugin = await this.platform.evaluate(this.ctx, 'environment:' + row.name, active.runId, '', () => () => {}, {
            module: artifact.host, services: installedServices(row), environment: true, network: row.permissions.network === true, activationId: row.activationId ?? row.digest,
          });
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
  async tick(): Promise<void> {
    await this.reconcile();
    for (const active of this.active.values()) {
      try {await this.platform.tick(active.runId);} catch {await this.stopNow(active.row.name); await this.owner.failed(active.row);}
    }
  }
  async nextAlarm(): Promise<number | undefined> {
    const values = await Promise.all([...this.active.values()].map(active => this.platform.nextAlarm(active.runId)));
    const due = values.filter((value): value is number => value !== undefined);
    return due.length ? Math.min(...due) : undefined;
  }
  async dispose(): Promise<void> {this.closed = true; for (const name of [...this.active.keys()]) await this.stopNow(name); await this.ctx.fiber.dispose();}
}
