import { Context, Service } from '@deepseek-ai/cordis';
import PluginMarket from '@deepseek-ai/dsh-plugin-market';
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types';
import Typert from '../../../.generated/official-typert-registry.js';
import marketRemote from '../../../.generated/official-remotes/packages/boot/plugin-market/typert.remote-client.js';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { invokeAgentRemote } from '../../harness-runtime/src/remote-dispatch.ts';

/** What the environment supplies to the original market reader. */
export interface MarketHost {
  /** Index URLs the environment settings hold. */
  indexes: string[];
  /** The environment's bundle listing, as `pluginManager/listBundles` reports it. */
  bundles(): Promise<BundleInfo[]>;
  /** Persist new index URLs; the settings write announces `plugin-market/changed`. */
  save(indexes: string[]): Promise<void>;
}

/** The installation status source the reader annotates listings with. */
class MarketBundles extends Service {
  constructor(ctx: Context, private readonly host: MarketHost) { super(ctx, 'pluginManager'); }
  listBundles(): Promise<BundleInfo[]> { return this.host.bundles(); }
  listVersionExemptions(): {exemptions: Record<string, readonly string[]>} { return {exemptions: {}}; }
}

/** The settings writer `setIndexes` commits through. */
class MarketSettings extends Service {
  constructor(ctx: Context, private readonly host: MarketHost) { super(ctx, 'settings'); }
  async update(_entryId: string, patch: {indexes: string[]}): Promise<void> { await this.host.save(patch.indexes); }
}

/** The settings namespace that holds the index URLs. */
export const MARKET_ENTRY = 'plugin-market';

export const isMarketEndpoint = (endpoint: string) => Object.hasOwn(marketRemote.methods, endpoint);

/**
 * The original market reader held by the environment, so its index cache and
 * last-read errors persist between calls as on the original Host. Replace it
 * when the index settings change. Installation stays with `pluginManager`.
 */
export class MarketWorld {
  private opened: Promise<Context> | undefined;
  constructor(private readonly host: MarketHost) {}
  private open(): Promise<Context> {
    return this.opened ??= (async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(Typert);
        await ctx.plugin(MarketBundles, this.host);
        await ctx.plugin(MarketSettings, this.host);
        await ctx.plugin(PluginMarket, {indexes: this.host.indexes});
        const market = ctx.get('pluginMarket');
        if (!market) throw new Error('Plugin market is not mounted');
        // The Loader names the settings entry; this world mounts the reader directly.
        Object.defineProperty(market, 'entryId', {value: MARKET_ENTRY});
        return ctx;
      } catch (error) { this.opened = undefined; await ctx.fiber.dispose(); throw error; }
    })();
  }
  async invoke(endpoint: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (!isMarketEndpoint(endpoint)) throw new RemoteError('gateway/method-unavailable', 'Unknown plugin market method', {endpoint});
    return invokeAgentRemote(await this.open(), marketRemote, endpoint, args, signal);
  }
  async dispose(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    await (await opened?.catch(() => undefined))?.fiber.dispose();
  }
}
