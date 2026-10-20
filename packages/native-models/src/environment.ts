import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { type LlmAdapter } from '@deepseek-ai/dsh-llm';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { buildModelCatalog } from '@weft/upstream/packages/api/session-controller/src/catalog.ts';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import Typert from '../../../.generated/official-typert-registry.js';
import llmRemote from '../../../.generated/official-remotes/packages/llm/llm/typert.remote-client.js';
import { invokeAgentRemote } from '../../harness-runtime/src/remote-dispatch.ts';
import { EnvironmentCredentialReader } from '../../native-environment/src/index.ts';
import { HarnessHome, type HarnessHomeFacts } from '../../native-environment/src/harness-home.ts';
import type { DeepSeekFileStore } from '@weft/upstream/packages/llm/llm-deepseek/src/file-store.ts';
import { defaultSelectionOf, mountNativeModels, type EnvironmentModels } from './index.ts';

/** What the EnvironmentDO supplies to its model world. */
export interface EnvironmentModelHost {
  models(): EnvironmentModels;
  resolveCredential(ref: string): Promise<{value: string; source: string} | undefined>;
  harnessHome(): HarnessHomeFacts & {deepSeekFiles: DeepSeekFileStore};
  /** Validation builds only: serve a fixed adapter in place of the configured providers. */
  validationAdapter?: () => LlmAdapter;
}

export const isEnvironmentModelEndpoint = (endpoint: string) => endpoint === 'session/modelCatalog' || Object.hasOwn(llmRemote.methods, endpoint);

/**
 * The official model providers held by the environment: the configurable
 * provider directory, provider and model listings, endpoint discovery and the
 * browser model catalog come from the original `llm` service and entries, as
 * the original Host serves them without a Session.
 */
export class EnvironmentModelWorld {
  private opened: Promise<{ctx: Context; commit: (next: EnvironmentModels) => Promise<void>}> | undefined;
  constructor(private readonly host: EnvironmentModelHost) {}
  private open() {
    return this.opened ??= (async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(Typert);
        await ctx.plugin(LlmRuntime);
        await ctx.plugin(HarnessHome, this.host.harnessHome());
        await ctx.plugin(EnvironmentCredentialReader, (ref: string) => this.host.resolveCredential(credentialRef(ref)));
        // Validation builds add a scripted route beside the configured providers; the directory stays the deployment's.
        if (this.host.validationAdapter) ctx.llm.registerAdapter(['validation'], this.host.validationAdapter());
        const commit = await mountNativeModels(ctx, this.host.models());
        return {ctx, commit};
      } catch (error) { this.opened = undefined; await ctx.fiber.dispose(); throw error; }
    })();
  }
  /** Commit the environment's current model settings to the running entries. */
  async refresh(): Promise<void> {
    if (!this.opened) return;
    await (await this.opened).commit(this.host.models());
  }
  async invoke(endpoint: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (!isEnvironmentModelEndpoint(endpoint)) throw new RemoteError('gateway/method-unavailable', 'Unknown model method', {endpoint});
    const {ctx} = await this.open();
    if (endpoint !== 'session/modelCatalog') return invokeAgentRemote(ctx, llmRemote, endpoint, args, signal);
    const {reasoningEffort, ...route} = defaultSelectionOf(this.host.models(), undefined);
    return buildModelCatalog(ctx, {...route, ...(reasoningEffort === undefined ? {} : {reasoningEffort})} as ModelCatalog['default']);
  }
  async dispose(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    await (await opened?.catch(() => undefined))?.ctx.fiber.dispose();
  }
}
