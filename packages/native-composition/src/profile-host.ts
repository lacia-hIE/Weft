import {Context} from '@deepseek-ai/cordis';
import Llm from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import remote from '../../../.generated/official-remotes/packages/preset/agent-preset-registry/typert.remote-client.js';
import {mountNativeComposition, nativePresetDefinition} from './index.ts';
import type {AgentRevision} from '../../control-plane/src/contracts.ts';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';

/** A real composition inspection world. It creates no Agent or session writer. */
export async function readNativePresets(profiles: AgentRevision[], defaultId: string, endpoint: 'agentPresets/list' | 'agentPresets/read', raw: unknown, mountWorkspace: (ctx: Context) => Promise<void>): Promise<Response> {
  const method = remote.methods[endpoint];
  const args = method.input({strict: true}).create().parse(raw);
  const ctx = new Context();
  try {
    await ctx.plugin(Llm);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(SystemPrompt, {personaPrefix: ''});
    await ctx.plugin(Tools);
    await ctx.plugin(Agents);
    await mountWorkspace(ctx);
    const registry = await mountNativeComposition(ctx, profiles.map(nativePresetDefinition), defaultId);
    const value = endpoint === 'agentPresets/list'
      ? await registry.remoteExportList()
      : await registry.readDocument('agentPreset' in args && typeof args.agentPreset === 'string' ? args.agentPreset : '');
    return Response.json({value: method.result.create().parse(value)});
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError('gateway/internal', 'Native preset inspection failed', {});
  } finally {await ctx.fiber.dispose();}
}
