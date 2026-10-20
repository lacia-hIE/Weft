import {EnvironmentUploadIndex, EnvironmentDeepSeekFiles} from '../../../packages/model-provider/src/files.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Env } from './index.ts';
import type { SessionScope } from '../../../packages/tenant/src/index.ts';
import type { AgentRevision } from '../../../packages/control-plane/src/contracts.ts';
import type { RuntimeOptions } from '../../../packages/harness-runtime/src/runtime.ts';
import type { createSessionReader } from '../../../packages/harness-runtime/src/session-reader.ts';
import { ModelConfigurationError, turnTimeoutFor } from '../../../packages/model-provider/src/index.ts';
import { credentialRefFor, defaultSelectionOf, mountNativeModels, readModelSections, type EnvironmentModels } from '../../../packages/native-models/src/index.ts';
import { EnvironmentCredentialReader } from '../../../packages/native-environment/src/index.ts';
import { ScriptedAdapter } from '../../../packages/harness-runtime/src/scripted-adapter.ts';
import { currentModelSelection } from '../../../packages/harness-runtime/src/model-selection.ts';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';

// Replaced with a literal by the build. Production cannot enable validation adapters.
declare const WEFT_VALIDATION_BUILD: boolean;
import { SqliteSessionPersistence } from '../../../packages/session-persistence-do/src/index.ts';
import { mountWorkspace } from '../../../packages/workspace/src/provider.ts';
import { workspaceAddress } from '../../../packages/workspace/src/protocol.ts';
import { mountPlugins } from '../../../packages/plugin-runtime/src/catalog.ts';
import { registerIdentityTool } from '../../../packages/harness-runtime/src/validation-tools.ts';
import { CLIENT_PLUGIN_GUIDE, mountClientPublisher } from '../../../packages/client-plugins/src/tool.ts';
import { mountClientInspection } from '../../../packages/client-plugins/src/inspect.ts';
import { NATIVE_PLUGIN_GUIDE } from '../../../packages/native-plugins/src/guide.ts';
import { controlFor, controlScope } from '../../../packages/control-plane/src/object.ts';
import {mountNativeComposition, nativePresetDefinition} from '../../../packages/native-composition/src/index.ts';
import type {Context} from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {updateVolatile} from '@deepseek-ai/cosmokit';
import {mountNativeAttachments} from '../../../packages/native-attachments/src/index.ts';
import {mountNativeSubagents, type SubagentLimits} from '../../../packages/native-subagents/src/index.ts';
import SessionFileReferences from '@weft/upstream/packages/api/session-controller/src/file-references.ts';
import {ComputerFileReferences} from '../../../packages/native-files/src/references.ts';
import {mountWorkspaceShell} from '../../../packages/workspace/src/subprocess.ts';
import {forwardNativeNotifications, mountNativeInteraction} from './native-interaction.ts';
import {HarnessHome} from '../../../packages/native-environment/src/harness-home.ts';

type Reader = Awaited<ReturnType<typeof createSessionReader>>;
export async function sessionRuntime(env: Env, storage: DurableObjectStorage, scope: SessionScope, profile: AgentRevision | undefined, workspaceId: string | null, persona: string, presentation: boolean, reader?: Reader, hooks: Pick<RuntimeOptions, 'onEvent' | 'onFrame'> = {}, cwd = '/workspace', requireCredential = true) {
  const owner = controlScope(scope.tenantId, scope.environmentId);
  const control = controlFor(env, owner);
  let runtimeRoot: Context | undefined;
  const files = new EnvironmentDeepSeekFiles(new EnvironmentUploadIndex(operation => control.nativeModelFiles(owner, operation)));
  const scripted = WEFT_VALIDATION_BUILD && env.MODEL_BACKEND === 'scripted';
  let models: EnvironmentModels | undefined = scripted ? undefined : await readModelSections(await control.nativeModelSections(owner));
  const selection = (): ModelSelection => {
    if (!models) return {provider: 'validation', model: 'scripted'};
    const {reasoningEffort, ...route} = defaultSelectionOf(models, profile?.spec.model?.name);
    return {...route, ...(reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(reasoningEffort)})};
  };
  if (models && requireCredential) {
    const ref = credentialRefFor(models, selection().provider);
    if (ref !== undefined && !await control.nativeResolveCredential(owner, credentialRef(ref))) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
  }
  const harnessHome = {...await control.nativeHarnessHome(owner), deepSeekFiles: files};
  let commitModels: ((next: EnvironmentModels) => Promise<void>) | undefined;
  const loop = await (await controlFor(env, owner).nativeLoopConfiguration(owner)).json() as {maxParallelToolCalls: number};
  let activeAgent: Agent | undefined;
  let composition: Context | undefined;
  let refreshSubagents: ((limits: SubagentLimits) => void) | undefined;
  const options: RuntimeOptions = {
    sessionId: scope.sessionId,
    persona: profile ? `${profile.spec.persona}\n${profile.spec.allowClientPlugins ? presentation ? NATIVE_PLUGIN_GUIDE : CLIENT_PLUGIN_GUIDE : ''}` : persona,
    model: selection(), presentation,
    mountModels: async ctx => {
      await ctx.plugin(HarnessHome, harnessHome);
      await ctx.plugin(EnvironmentCredentialReader, (ref: string) => control.nativeResolveCredential(owner, credentialRef(ref)));
      if (models) commitModels = await mountNativeModels(ctx, models);
      else if (WEFT_VALIDATION_BUILD) ctx.llm.registerAdapter(['validation'], new ScriptedAdapter());
      else throw new Error('Environment model settings are unavailable');
    },
    agentLoop: {maxParallelToolCalls: loop.maxParallelToolCalls},
    defaultModel: selection,
    beforeAssembly: async () => {
      if (models) {
        models = await readModelSections(await control.nativeModelSections(owner));
        await commitModels?.(models);
        // Admission fails fast, before the turn queues, when the next route names a credential that is not set.
        const ref = credentialRefFor(models, (activeAgent && currentModelSelection(activeAgent) || selection()).provider);
        if (ref !== undefined && !await control.nativeResolveCredential(owner, credentialRef(ref))) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
      }
      const next = await (await controlFor(env, owner).nativeLoopConfiguration(owner)).json() as {maxParallelToolCalls: number};
      if (runtimeRoot) updateVolatile(runtimeRoot.agentLoop.config.maxParallelToolCalls, AgentLoop.Config({maxParallelToolCalls: next.maxParallelToolCalls}).maxParallelToolCalls);
      if (refreshSubagents) refreshSubagents(await (await controlFor(env, owner).nativeSubagentConfiguration(owner)).json() as SubagentLimits);
    },
    ...(presentation ? {meta: {cwd, ...(profile ? {agentPreset: profile.spec.id} : {})}} : {}),
    ...(presentation && profile ? {setupAgent: async (ctx, agent) => {
      if (!composition) throw new Error('Native composition is not ready');
      await composition.agentPresets.mount(ctx, composition.sessionProjections.stateOf(agent.session, 'agentPreset') ?? profile.spec.id);
    }} : {}),
    onAgent: (agent, ctx) => { activeAgent = agent; runtimeRoot = ctx; ctx.get('weftNativeUploadRegistry')?.reconcile(agent); reader?.activate(agent, ctx); },
    onAgentDisposed: agent => { if (activeAgent === agent) activeAgent = undefined; reader?.dispose(agent); },
    onSessionCreated: session => { reader?.created(session); },
    onSessionDisposed: session => { reader?.sessionDisposed(session); },
    onEvent: (event, session) => { reader?.event(session, event); hooks.onEvent?.(event, session); },
    onFrame: (frame, agent) => { reader?.frame(agent, frame); hooks.onFrame?.(frame, agent); },
    mountPersistence: async ctx => { await ctx.plugin(SqliteSessionPersistence, {storage}); },
    mountTools: async ctx => {
      registerIdentityTool(ctx, scope.tenantId);
      if (presentation) forwardNativeNotifications(ctx, env, owner, () => activeAgent !== undefined);
      if (presentation) ctx.on('agent/created', async ({agent}) => {
        const header = agent.session.header;
        if (header.origin !== 'subagent') return;
        if (!header.parentSession) throw new Error('Native child has no parent');
        await controlFor(env, owner).nativeRegisterChild(owner, scope.sessionId, header.parentSession, agent.id);
      }, {global: true});
      if (workspaceId !== null) {
        const workspace = {tenantId: scope.tenantId, workspaceId, ...(scope.environmentId ? {environmentId: scope.environmentId} : {})};
        await mountWorkspace(ctx, {scope: workspace, transport: env.WORKSPACES.getByName(workspaceAddress(workspace)), cwd, readImage: presentation && env.IMAGES !== undefined});
        if (presentation) {await ctx.plugin(ComputerFileReferences); await ctx.plugin(SessionFileReferences);}
        if (presentation) {
          const stub = env.WORKSPACES.getByName(workspaceAddress(workspace));
          await mountWorkspaceShell(ctx, {exec: request => stub.exec(workspace, request), kill: id => stub.killExec(workspace, id)}, cwd);
        }
        if (presentation) await mountNativeAttachments(ctx, {storage, scope: workspace, sessionId: scope.sessionId, transport: env.WORKSPACES.getByName(workspaceAddress(workspace)), ...(env.IMAGES ? {images: env.IMAGES} : {})});
      }
      if (profile) {
        if (presentation) refreshSubagents = await mountNativeSubagents(ctx, storage, await (await controlFor(env, owner).nativeSubagentConfiguration(owner)).json() as SubagentLimits);
        if (presentation) await mountNativeInteraction(ctx, env, storage, scope, owner);
        if (presentation) {await mountNativeComposition(ctx, [nativePresetDefinition(profile)], profile.spec.id); composition = ctx;}
        else await mountPlugins(ctx, profile.spec.plugins);
        if (profile.spec.allowClientPlugins && !presentation) {
          await mountClientInspection(ctx);
          mountClientPublisher(ctx, input => controlFor(env, controlScope(scope.tenantId, scope.environmentId)).publishClient(controlScope(scope.tenantId, scope.environmentId), input));
        }
      }
      if (presentation) ctx.on('agent/disposed', ({agent}) => {
        if (agent.id !== scope.sessionId) reader?.dispose(agent);
      }, {global: true});
    },
  };
  return {options, turnTimeoutMs: turnTimeoutFor(env)};
}
