import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

const selections = new WeakMap<Agent, {refresh?: () => Promise<void>; tail: Promise<void>}>();

/**
 * The original Agent owns its durable selection (`agent.model`) and the Agent
 * loop registers its projection. Installs the original switch notice in the
 * Agent's unpublished setup scope, as the session controller's composition does.
 */
export function setupModelSelection(agentCtx: Context): void {
  installModelSelection(agentCtx);
}

/** Serializes selection requests for one presentation Agent; `refresh` reloads environment model settings first. */
export function mountModelSelection(agent: Agent, refresh?: () => Promise<void>): void {
  selections.set(agent, {...(refresh ? {refresh} : {}), tail: Promise.resolve()});
}

/** The route an Agent's next request uses: its Session selection, else its creation options. */
export function currentModelSelection(agent: Agent): import('@deepseek-ai/dsh-agent').ModelSelection | undefined {
  return agent.model.current();
}

export async function selectLiveHarnessModel(ctx: Context, agent: Agent, request: ModelSelection): Promise<{selected: ModelSelection}> {
  const owner = selections.get(agent);
  if (!owner) throw new RemoteError('session/model-unavailable', 'Agent model selection is not mounted', {provider: request.provider, model: request.model});
  const operation = owner.tail.then(async () => {
  try {
    await owner.refresh?.();
    const models = await ctx.llm.listModels(request.provider);
    if (!models.some(model => model.id === request.model)) throw new Error('Model is absent from the configured provider catalog');
    const resolved = await ctx.llm.resolveCallConfig({
      provider: request.provider, model: request.model,
      ...(request.reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(request.reasoningEffort)}),
    });
    const selected = {provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : {reasoningEffort: resolved.reasoningEffort})};
    agent.ctx.fiber.assertActive();
    agent.model.select(selected);
    await ctx.get('sessionPersistence')?.flush();
    return {selected};
  } catch (error) {
    throw new RemoteError('session/model-unavailable', 'The requested model or reasoning effort is unavailable', {provider: request.provider, model: request.model});
  }
  });
  owner.tail = operation.then(() => {}, () => {});
  return operation;
}
