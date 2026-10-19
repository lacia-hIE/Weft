import type {Context} from '@deepseek-ai/cordis';
import {installDurableSessionQuery} from '../../native-query/src/index.ts';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process';
import {updateVolatile} from '@deepseek-ai/cosmokit';

export interface SubagentLimits {maxDepth: number; maxActiveSubagents: number;}

/** Native local providers share the owner's workerd Context and canonical log store. */
export async function mountNativeSubagents(ctx: Context, storage: DurableObjectStorage, limits: SubagentLimits) {
  await installDurableSessionQuery(ctx, storage, 'runtime');
  return mountNativeSubagentProviders(ctx, limits);
}

/** Inspection also composes real providers, without creating an Agent or log. */
export async function mountNativeSubagentProviders(ctx: Context, limits: SubagentLimits) {
  const fiber = await ctx.plugin(Subagents, limits);
  const config = fiber.config as ReturnType<typeof Subagents.Config>;
  await ctx.plugin(Spawn, {providerName: 'spawn'});
  await ctx.plugin(Fork, {providerName: 'fork'});
  return (limits: SubagentLimits) => {
    const next = Subagents.Config(limits);
    updateVolatile(config.maxDepth, next.maxDepth);
    updateVolatile(config.maxActiveSubagents, next.maxActiveSubagents);
  };
}
