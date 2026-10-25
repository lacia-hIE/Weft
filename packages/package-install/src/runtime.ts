import type {Context, Fiber, Plugin} from '@deepseek-ai/cordis';
import {NativePluginPlatform} from '../../native-plugins/src/platform.ts';
import type {Artifact, Installation} from './contracts.ts';

interface Active {
  installation: Installation; runId: string; fiber?: Fiber;
}
function authority(row: Installation): string {
  const p = row.permissions;
  return JSON.stringify([row.digest, p.files, p.tools, p.timer, p.client]);
}
/** Per-Session activations; declarations, grants and module authority remain in EnvironmentDO. */
export class InstalledPackageRuntime {
  private readonly active = new Map<string, Active>();
  private readonly failed = new Map<string, string>();
  private readonly platform: NativePluginPlatform;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: Context, private readonly state: DurableObjectState, loader: WorkerLoader | undefined, scope: object,
    private readonly source: {list(): Promise<Installation[]>; artifact(name: string, digest: string): Promise<Artifact>; capability(pluginId: string, runId: string): Fetcher; failed?(name: string, digest: string): Promise<boolean>}) {
    this.platform = new NativePluginPlatform(state, loader, scope, source.capability);
    this.platform.onFault((runId) => {const entry = [...this.active.values()].find(row => row.runId === runId); if (entry) state.waitUntil(this.stop(entry.installation.name));});
    ctx.effect(() => () => Promise.all([...this.active.keys()].map(name => this.stop(name))).then(() => {}), 'weft.installed-packages');
  }
  reconcile(): Promise<void> {
    const operation = this.tail.catch(() => {}).then(async () => {
      const selected = (await this.source.list()).filter(row => row.enabled && row.approved);
      for (const name of this.failed.keys()) if (!selected.some(row => row.name === name && authority(row) === this.failed.get(name))) this.failed.delete(name);
      for (const [name, row] of this.active) if (!selected.some(next => next.name === name && authority(next) === authority(row.installation))) await this.stopNow(name);
      for (const installation of selected) {
        if (this.active.has(installation.name) || this.failed.get(installation.name) === authority(installation)) continue;
        const runId = 'installed-' + crypto.randomUUID();
        const row: Active = {installation, runId};
        this.active.set(installation.name, row);
        try {
          const artifact = await this.source.artifact(installation.name, installation.digest);
          if (artifact.host) {
            const p = installation.permissions;
            const services = [...(p.files !== 'none' ? ['fs'] : []), ...(p.tools ? ['tools'] : []), ...(p.timer ? ['timer'] : [])];
            const plugin = await this.platform.evaluate(this.ctx, `installed:${installation.name}`, runId, '', () => {throw new Error('Bundle handlers use native Cordis services');}, {module: artifact.host, services});
            row.fiber = this.ctx.plugin(plugin as Plugin);
            await row.fiber.await();
          }
        } catch (error) {
          await this.stopNow(installation.name);
          this.failed.set(installation.name, authority(installation));
          // A broken optional package must not make a Session or its built-in tools unavailable.
          console.warn('weft.package.activation.failed', {name: installation.name, message: error instanceof Error ? error.message : String(error)});
          // Do not hold Session reconciliation while reporting to its owner:
          // the owner may be waiting for this Session to stop an old version.
          if (this.source.failed) this.state.waitUntil(this.source.failed(installation.name, installation.digest).catch(() => {}));
        }
      }
    });
    this.tail = operation; return operation;
  }
  async stop(name: string): Promise<void> {
    const next = this.tail.catch(() => {}).then(async () => {this.failed.delete(name); await this.stopNow(name);});
    this.tail = next; await next;
  }
  private async stopNow(name: string): Promise<void> {
    const row = this.active.get(name); if (!row) return;
    this.active.delete(name);
    await row.fiber?.dispose(); await this.platform.release(row.runId);
  }
  permission(pluginId: string, runId: string): Installation | undefined {
    const name = pluginId.startsWith('installed:') ? pluginId.slice('installed:'.length) : '';
    const row = this.active.get(name); return row?.runId === runId ? row.installation : undefined;
  }
}
