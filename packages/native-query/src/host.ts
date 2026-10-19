import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';
import {EnvironmentSessionPersistence, type SearchPersistencePorts} from './persistence.ts';
import {installDurableSessionQuery} from './index.ts';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';

/** The official authorized search controller over the environment's real corpus. */
export class NativeSessionSearch {
  private readonly ready: Promise<{ctx: Context; list: ApiSessionList}>;
  constructor(storage: DurableObjectStorage, ports: SearchPersistencePorts) {
    this.ready = (async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(Sessions);
        await ctx.plugin(Projections);
        await ctx.plugin(EnvironmentSessionPersistence, ports);
        await installDurableSessionQuery(ctx, storage);
        return {ctx, list: new ApiSessionList(ctx, 8)};
      } catch (error) {await ctx.fiber.dispose(); throw error;}
    })();
    void this.ready.catch(() => {});
  }
  async search(query: string, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      return await (await this.ready).list.search(query, signal);
    } catch (error) {
      // The original controller deliberately rethrows the signal's AbortError.
      // Its Node gateway normally maps that error; Fetch is our gateway here.
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'Session search was aborted', {});
      throw error;
    }
  }
  async dispose(): Promise<void> {await (await this.ready).ctx.fiber.dispose();}
}
