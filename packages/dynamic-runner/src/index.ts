import { cordisModule } from "../../../.generated/dynamic-cordis.ts";

export interface DynamicRunSpec {
  tenantId: string;
  revision: string;
  source: string;
  config: Record<string, unknown>;
}
const entry = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Context, Inject } from './cordis.js';
import * as module from './plugin.js';
export default class extends WorkerEntrypoint {
  async run(input) {
    const ctx = new Context();
    try {
      ctx.reflect.provide('host', this.env.HOST);
      const plugin = module.default ?? module;
      const required = Object.keys(Inject.resolve(plugin.inject));
      if (required.some(name => ctx.get(name) === undefined)) throw new Error('Plugin requires a host service that this runner does not expose');
      await ctx.plugin(plugin, this.env.CONFIG);
      const api = ctx.get('pluginApi');
      if (!api || typeof api.run !== 'function') throw new Error('Plugin must provide pluginApi.run');
      return await api.run(input);
    } finally { await ctx.fiber.dispose(); }
  }
}`;

/** Experimental runner seam. Only scoped host capabilities cross the isolate.
 * This is not yet a transparent replacement for upstream's Node VM runner.
 */
export async function createDynamicRunner(
  loader: WorkerLoader,
  spec: DynamicRunSpec,
  host: Fetcher,
): Promise<Fetcher> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([spec.tenantId, spec.revision, spec.source, spec.config]),
    ),
  );
  const key =
    "weft-plugin:" +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  return loader
    .get(key, () => ({
      compatibilityDate: "2026-07-30",
      mainModule: "runner.js",
      modules: {
        "runner.js": entry,
        "cordis.js": cordisModule,
        "plugin.js": spec.source,
      },
      env: { HOST: host, CONFIG: spec.config },
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 20 },
    }))
    .getEntrypoint();
}
