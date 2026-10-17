import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Env } from './index.ts';
import type { SessionScope } from '../../../packages/tenant/src/index.ts';
import type { AgentRevision } from '../../../packages/control-plane/src/contracts.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import type { createSessionReader } from '../../../packages/harness-runtime/src/session-reader.ts';
import { resolveTenantModel, readEnvironmentModelConfiguration } from '../../../packages/model-provider/src/index.ts';
import { SqliteSessionPersistence } from '../../../packages/session-persistence-do/src/index.ts';
import { mountWorkspace } from '../../../packages/workspace/src/provider.ts';
import { workspaceAddress } from '../../../packages/workspace/src/protocol.ts';
import { mountPlugins } from '../../../packages/plugin-runtime/src/catalog.ts';
import { registerIdentityTool } from '../../../packages/harness-runtime/src/validation-tools.ts';
import { CLIENT_PLUGIN_GUIDE, mountClientPublisher } from '../../../packages/client-plugins/src/tool.ts';
import { mountClientInspection } from '../../../packages/client-plugins/src/inspect.ts';
import { controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';

type Reader = Awaited<ReturnType<typeof createSessionReader>>;
export async function sessionRuntime(env: Env, storage: DurableObjectStorage, scope: SessionScope, profile: AgentRevision | undefined, workspaceId: string | null, persona: string, presentation: boolean, reader?: Reader, hooks: Pick<RuntimeOptions, 'onEvent' | 'onFrame'> = {}, cwd = '/workspace') {
  const owner = controlScope(scope.tenantId, scope.environmentId);
  const configuration = await readEnvironmentModelConfiguration(await controlFor(env, owner).nativeModelConfiguration(owner));
  const model = resolveTenantModel(env, scope.tenantId, profile?.spec.model, configuration);
  let activeAgent: Agent | undefined;
  const options: RuntimeOptions = {
    sessionId: scope.sessionId,
    persona: profile ? `${profile.spec.persona}\n${profile.spec.allowClientPlugins ? CLIENT_PLUGIN_GUIDE : ''}` : persona,
    model: model.model, adapter: model.adapter, presentation,
    ...(model.currentSelection ? {defaultModel: model.currentSelection} : {}),
    ...(model.refresh ? {beforeAssembly: async () => {
      const next = await readEnvironmentModelConfiguration(await controlFor(env, owner).nativeModelConfiguration(owner));
      model.refresh!(next);
    }} : {}),
    ...(presentation ? {meta: {cwd, ...(profile ? {agentPreset: profile.spec.id} : {})}} : {}),
    onAgent: (agent, ctx) => { activeAgent = agent; reader?.activate(agent, ctx); },
    onAgentDisposed: agent => { if (activeAgent === agent) activeAgent = undefined; reader?.dispose(agent); },
    onSessionCreated: session => { reader?.created(session); },
    onSessionDisposed: session => { reader?.sessionDisposed(session); },
    onEvent: (event, session) => { reader?.event(session, event); hooks.onEvent?.(event, session); },
    onFrame: frame => { if (activeAgent) reader?.frame(activeAgent, frame); hooks.onFrame?.(frame); },
    mountPersistence: async ctx => { await ctx.plugin(SqliteSessionPersistence, {storage}); },
    mountTools: async ctx => {
      registerIdentityTool(ctx, scope.tenantId);
      if (workspaceId !== null) {
        const workspace = {tenantId: scope.tenantId, workspaceId, ...(scope.environmentId ? {environmentId: scope.environmentId} : {})};
        await mountWorkspace(ctx, {scope: workspace, transport: env.WORKSPACES.getByName(workspaceAddress(workspace)), cwd});
      }
      if (profile) {
        await mountPlugins(ctx, profile.spec.plugins);
        if (profile.spec.allowClientPlugins) {
          await mountClientInspection(ctx);
          mountClientPublisher(ctx, input => controlFor(env, controlScope(scope.tenantId, scope.environmentId)).publishClient(controlScope(scope.tenantId, scope.environmentId), input));
        }
      }
    },
  };
  return {options, turnTimeoutMs: model.turnTimeoutMs};
}
