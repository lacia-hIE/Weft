import type {Context, Fiber, Plugin} from '@deepseek-ai/cordis';
import {NativePluginPlatform} from '../../native-plugins/src/platform.ts';
import type {Artifact, Installation} from './contracts.ts';

interface Active {
  installation: Installation; runId: string; fiber?: Fiber;
  handlers: Map<string, (args: unknown) => Promise<unknown>>;
}
/** Per-Session activations; declarations, grants and module authority remain in EnvironmentDO. */
export class InstalledPackageRuntime {
  private readonly active = new Map<string, Active>();
  private readonly failed = new Map<string, string>();
  private readonly platform: NativePluginPlatform;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: Context, state: DurableObjectState, loader: WorkerLoader | undefined, scope: object,
    private readonly source: {list(): Promise<Installation[]>; artifact(name: string, digest: string): Promise<Artifact>; capability(pluginId: string, runId: string): Fetcher}) {
    this.platform = new NativePluginPlatform(state, loader, scope, source.capability);
    this.platform.onFault((runId) => {const entry = [...this.active.values()].find(row => row.runId === runId); if (entry) state.waitUntil(this.stop(entry.installation.name));});
    ctx.effect(() => () => Promise.all([...this.active.keys()].map(name => this.stop(name))).then(() => {}), 'weft.installed-packages');
  }
  reconcile(): Promise<void> {
    const operation = this.tail.catch(() => {}).then(async () => {
      const selected = (await this.source.list()).filter(row => row.enabled && row.approved);
      for (const name of this.failed.keys()) if (!selected.some(row => row.name === name && row.digest === this.failed.get(name))) this.failed.delete(name);
      for (const [name, row] of this.active) if (!selected.some(next => next.name === name && next.digest === row.installation.digest)) await this.stopNow(name);
      for (const installation of selected) {
        if (this.active.has(installation.name) || this.failed.get(installation.name) === installation.digest) continue;
        const runId = 'installed-' + crypto.randomUUID();
        const row: Active = {installation, runId, handlers: new Map()};
        this.active.set(installation.name, row);
        try {
          const artifact = await this.source.artifact(installation.name, installation.digest);
          if (artifact.host) {
            const p = installation.permissions;
            const services = [...(p.files !== 'none' ? ['fs'] : []), ...(p.tools ? ['tools'] : []), ...(p.timer ? ['timer'] : [])];
            const plugin = await this.platform.evaluate(this.ctx, `installed:${installation.name}`, runId, '', (method, fn) => {
              if (typeof method !== 'string' || typeof fn !== 'function') throw new Error('Invalid installed handler');
              const handler = fn as (args: unknown) => Promise<unknown>;
              row.handlers.set(method, handler);
              return () => {if (row.handlers.get(method) === handler) row.handlers.delete(method);};
            }, {module: artifact.host, services});
            row.fiber = this.ctx.plugin(plugin as Plugin);
            await row.fiber.await();
          }
        } catch (error) {
          await this.stopNow(installation.name);
          this.failed.set(installation.name, installation.digest);
          // A broken optional package must not make a Session or its built-in tools unavailable.
          console.warn('weft.package.activation.failed', {name: installation.name, message: error instanceof Error ? error.message : String(error)});
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
    await row.fiber?.dispose(); await this.platform.release(row.runId); row.handlers.clear();
  }
  permission(pluginId: string, runId: string): Installation | undefined {
    const name = pluginId.startsWith('installed:') ? pluginId.slice('installed:'.length) : '';
    const row = this.active.get(name); return row?.runId === runId ? row.installation : undefined;
  }
  async invoke(name: string, digest: string, method: string, args: unknown): Promise<unknown> {
    await this.reconcile();
    const row = this.active.get(name);
    if (!row || row.installation.digest !== digest) throw new Error('Installed package is not active');
    const fn = row.handlers.get(method); if (!fn) throw new Error('Installed package handler is unavailable');
    return fn(args);
  }
}
