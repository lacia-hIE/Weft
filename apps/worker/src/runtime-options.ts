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
import { controlFor, controlScope, type NativeSessionContext } from '../../../packages/control-plane/src/object.ts';
import {mountNativeComposition, nativePresetDefinition} from '../../../packages/native-composition/src/index.ts';
import type {Context} from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {updateVolatile} from '@deepseek-ai/cosmokit';
import {mountNativeAttachments} from '../../../packages/native-attachments/src/index.ts';
import {mountSessionExport} from '../../../packages/harness-runtime/src/session-export.ts';
import {mountWorkerPlugins} from '../../../packages/worker-plugins/src/runtime.ts';
import {mountOfficialTeam} from '../../../packages/native-bundles/src/runtime.ts';
import {mountNativeSubagents, type SubagentLimits} from '../../../packages/native-subagents/src/index.ts';
import SessionFileReferences from '@weft/upstream/packages/api/session-controller/src/file-references.ts';
import {ComputerFileReferences} from '../../../packages/native-files/src/references.ts';
import {mountWorkspaceShell} from '../../../packages/workspace/src/subprocess.ts';
import {WorkerPtcRuntime} from '../../../packages/native-ptc/src/index.ts';
import {reconcileProfileOverrides, reconcileProfileEnablement} from '../../../packages/native-profile/src/loader.ts';
import {mountWorkspaceChanges} from '../../../packages/workspace/src/changes.ts';
import {WorkspaceRuntimeChoice} from '../../../packages/workspace/src/runtime-choice.ts';
import {PROCESS_PATH} from '../../../packages/workspace/src/process-protocol.ts';
import {SPILL_ROOT, WorkspaceSpillStore} from '../../../packages/workspace/src/spill.ts';
import {forwardNativeNotifications, mountNativeInteraction} from './native-interaction.ts';
import {HarnessHome} from '../../../packages/native-environment/src/harness-home.ts';

type Reader = Awaited<ReturnType<typeof createSessionReader>>;
/** The root persona prefix of a Session composed without preset realms: its persona row's text, else the Agent persona. */
function rootPersona(profile: AgentRevision): string {
  const prefix = profile.spec.plugins.find(plugin => plugin.id === 'persona')?.config.prefix;
  return typeof prefix === 'string' ? prefix : profile.spec.persona;
}

export async function sessionRuntime(env: Env, storage: DurableObjectStorage, scope: SessionScope, profile: AgentRevision | undefined, workspaceId: string | null, persona: string, presentation: boolean, reader?: Reader, hooks: Pick<RuntimeOptions, 'onEvent' | 'onFrame'> = {}, cwd = '/workspace', requireCredential = true) {
  const owner = controlScope(scope.tenantId, scope.environmentId);
  const control = controlFor(env, owner);
  let runtimeRoot: Context | undefined;
  const files = new EnvironmentDeepSeekFiles(new EnvironmentUploadIndex(operation => control.nativeModelFiles(owner, operation)));
  const scripted = WEFT_VALIDATION_BUILD && env.MODEL_BACKEND === 'scripted';
  // One round trip for the environment's settings; each further turn refreshes it the same way.
  let context = await (await control.nativeSessionContext(owner)).json() as NativeSessionContext;
  let models: EnvironmentModels | undefined = scripted ? undefined : context.models as EnvironmentModels;
  /** Whether the credential a route names has a value; a reference the context did not report is resolved directly. */
  const credentialSet = async (ref: string) => context.credentials[ref] ?? await control.nativeResolveCredential(owner, credentialRef(ref)) !== undefined;
  const selection = (): ModelSelection => {
    if (!models) return {provider: 'validation', model: 'scripted'};
    const {reasoningEffort, ...route} = defaultSelectionOf(models, profile?.spec.model?.name);
    return {...route, ...(reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(reasoningEffort)})};
  };
  if (models && requireCredential) {
    const ref = credentialRefFor(models, selection().provider);
    if (ref !== undefined && !await credentialSet(ref)) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
  }
  const harnessHome = {...context.harnessHome, deepSeekFiles: files};
  let commitModels: ((next: EnvironmentModels) => Promise<void>) | undefined;
  const loop = context.loop;
  let profileOverrides = presentation ? context.profileOverrides : {};
  let profileEnablement = presentation ? context.profileEnablement : {};
  let profileEnablementTurn: number | undefined;
  let world: Context | undefined;
  let activeAgent: Agent | undefined;
  let composition: Context | undefined;
  let refreshSubagents: ((limits: SubagentLimits) => void) | undefined;
  let reconcileChanges: (() => Promise<void>) | undefined;
  let reconcileWorkerPlugins: Awaited<ReturnType<typeof mountWorkerPlugins>> | undefined;
  let runtimeChoice: WorkspaceRuntimeChoice | undefined;
  const options: RuntimeOptions = {
    sessionId: scope.sessionId,
    persona: profile ? `${presentation ? profile.spec.persona : rootPersona(profile)}\n${profile.spec.allowClientPlugins ? presentation ? NATIVE_PLUGIN_GUIDE : CLIENT_PLUGIN_GUIDE : ''}` : persona,
    model: selection(), presentation,
    mountModels: async ctx => {
      world = ctx;
      await ctx.plugin(HarnessHome, harnessHome);
      await ctx.plugin(EnvironmentCredentialReader, (ref: string) => control.nativeResolveCredential(owner, credentialRef(ref)));
      if (models) commitModels = await mountNativeModels(ctx, models);
      else if (WEFT_VALIDATION_BUILD) ctx.llm.registerAdapter(['validation'], new ScriptedAdapter());
      else throw new Error('Environment model settings are unavailable');
    },
    agentLoop: {maxParallelToolCalls: loop.maxParallelToolCalls},
    profileOverrides,
    profileEnablement,
    defaultModel: selection,
    beforeAssembly: async () => {
      context = await (await control.nativeSessionContext(owner)).json() as NativeSessionContext;
      if (models) {
        models = context.models as EnvironmentModels;
        await commitModels?.(models);
        // Admission fails fast, before the turn queues, when the next route names a credential that is not set.
        const ref = credentialRefFor(models, (activeAgent && currentModelSelection(activeAgent) || selection()).provider);
        if (ref !== undefined && !await credentialSet(ref)) throw new ModelConfigurationError('MODEL_NOT_CONFIGURED');
      }
      const next = context.loop;
      if (runtimeRoot) updateVolatile(runtimeRoot.agentLoop.config.maxParallelToolCalls, AgentLoop.Config({maxParallelToolCalls: next.maxParallelToolCalls}).maxParallelToolCalls);
      if (refreshSubagents) refreshSubagents(context.subagents as unknown as SubagentLimits);
      // Settings edits to official profile rows reach a live Session before its next turn.
      if (presentation && world) {
        profileOverrides = await reconcileProfileOverrides(world, profileOverrides, context.profileOverrides);
        const boundary = activeAgent && world.sessionProjections.stateOf(activeAgent.session, 'turnBoundary');
        // Assembly also runs between steps and model selection can refresh while a turn is active.
        // Change policy fibers only at that turn's first assembly, or while the Agent is idle.
        if (boundary?.openTurnStartSeq == null || profileEnablementTurn !== boundary.lastTurn) {
          profileEnablementTurn = boundary?.openTurnStartSeq != null ? boundary.lastTurn : undefined;
          profileEnablement = await reconcileProfileEnablement(world, profileEnablement, context.profileEnablement);
          await reconcileWorkerPlugins?.(context.workerPlugins);
        }
      }
      await runtimeChoice?.reconcile();
      await reconcileChanges?.();
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
      // run_code programs run in per-run Dynamic Workers; PTC presentation waits for this service.
      if (presentation) await ctx.plugin(WorkerPtcRuntime, {...(env.LOADER ? {loader: env.LOADER} : {}), cwd});
      if (presentation) ctx.on('agent/created', async ({agent}) => {
        const header = agent.session.header;
        if (header.origin !== 'subagent') return;
        if (!header.parentSession) throw new Error('Native child has no parent');
        await controlFor(env, owner).nativeRegisterChild(owner, scope.sessionId, header.parentSession, agent.id);
      }, {global: true});
      if (workspaceId !== null) {
        const workspace = {tenantId: scope.tenantId, workspaceId, ...(scope.environmentId ? {environmentId: scope.environmentId} : {})};
        await mountWorkspace(ctx, {scope: workspace, transport: env.WORKSPACES.getByName(workspaceAddress(workspace)), cwd, fileTools: !presentation});
        if (presentation) {await ctx.plugin(ComputerFileReferences); await ctx.plugin(SessionFileReferences);}
        // Oversized tool results spill into the workspace, where the model reads them back with the file tools.
        if (presentation) {
          const files = env.WORKSPACES.getByName(workspaceAddress(workspace));
          await ctx.plugin(WorkspaceSpillStore, {sweep: async before => {
            const response = await files.call(workspace, {type: 'sweep', path: SPILL_ROOT, before});
            const body = await response.json() as {value?: {removed: number}; error?: string};
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
            return body.value!.removed;
          }});
        }
        if (presentation) {
          const stub = env.WORKSPACES.getByName(workspaceAddress(workspace));
          // The environment, or under `auto` the agent, chooses where commands run; ripgrep requests the container itself.
          runtimeChoice = new WorkspaceRuntimeChoice(ctx, storage, () => context.workspaceRuntime.shell);
          const choice = runtimeChoice;
          await mountWorkspaceShell(ctx, {exec: async ({container, ...request}) => {
            const runtime = context.workspaceRuntime;
            if (container && runtime.shell === 'worker') return Response.json({error: 'This environment does not allow the workspace container', code: 'EXEC_UNAVAILABLE'}, {status: 403});
            return stub.exec(workspace, {...request, ...(container || choice.container() ? {container: {instance: runtime.containerInstance}} : {})});
          }, kill: id => stub.killExec(workspace, id), container: () => choice.container(),
          connectProcess: epoch => {
            if (context.workspaceRuntime.shell === 'worker') throw new Error('This environment does not allow the workspace container');
            return stub.fetch(new Request(`https://workspace.internal${PROCESS_PATH}`, {headers: {
              upgrade: 'websocket', 'x-weft-workspace': JSON.stringify(workspace),
              'x-weft-process-owner': scope.sessionId, 'x-weft-container-instance': context.workspaceRuntime.containerInstance,
              ...(epoch === undefined ? {} : {'x-weft-container-epoch': String(epoch)}),
            }}));
          }, syncProcesses: epoch => stub.syncProcesses(workspace, true, epoch)}, cwd);
          await choice.reconcile();
        }
        if (presentation) await mountNativeAttachments(ctx, {storage, scope: workspace, sessionId: scope.sessionId, transport: env.WORKSPACES.getByName(workspaceAddress(workspace)), ...(env.IMAGES ? {images: env.IMAGES} : {})});
        if (presentation) await mountSessionExport(ctx);
        if (presentation) reconcileWorkerPlugins = await mountWorkerPlugins(ctx, workspace, env.WORKSPACES.getByName(workspaceAddress(workspace)), () => control.nativeWorkerPlugins(owner), context.workerPlugins);
        // Change summaries come from git snapshots in the workspace container, so they follow the environment's shell.
        if (presentation) {
          reconcileChanges = mountWorkspaceChanges(ctx, () => runtimeChoice?.container() === true);
          await reconcileChanges();
        }
      }
      if (profile) {
        if (presentation) refreshSubagents = await mountNativeSubagents(ctx, storage, context.subagents as unknown as SubagentLimits);
        if (presentation) await mountNativeInteraction(ctx, env, storage, scope, owner, {models: context.models as EnvironmentModels, ...(context.permissionDefault === undefined ? {} : {permissionDefault: context.permissionDefault})});
        if (presentation) await mountOfficialTeam(ctx, [profile]);
        if (presentation) {await mountNativeComposition(ctx, [nativePresetDefinition(profile)], profile.spec.id); composition = ctx;}
        // Without preset realms the persona row's text is the root prefix; the root owns that prompt section.
        else await mountPlugins(ctx, profile.spec.plugins.filter(plugin => plugin.id !== 'persona'));
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
