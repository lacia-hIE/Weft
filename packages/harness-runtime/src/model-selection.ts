import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
export { installModelSelectionProjection } from '@weft/upstream/packages/api/session-controller/src/model-selection-projection.ts';

const selections = new WeakMap<Agent, ModelSelectionRef>();

/** Native durable intent and native assembly hooks, without the Node host controller. */
export function mountModelSelection(ctx: Context, agent: Agent): void {
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
  const last = agent.session.requestHeader();
  const selected = state?.pending ?? (last ? {
    provider: last.config.provider, model: last.config.model,
    ...(last.config.reasoningEffort === undefined || last.adapterDefaults?.reasoningEffort
      ? {} : {reasoningEffort: String(last.config.reasoningEffort)}),
  } : undefined);
  const ref: ModelSelectionRef = {
    current: selected ? {provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(selected.reasoningEffort)})} : undefined,
    assembled: undefined,
  };
  selections.set(agent, ref);
  agent.ctx.effect(() => installModelSelection(agent.ctx, ref), 'weft.native-model-selection');
}

export async function selectLiveHarnessModel(ctx: Context, agent: Agent, request: ModelSelection): Promise<{selected: ModelSelection}> {
  try {
    const models = await ctx.llm.listModels(request.provider);
    if (!models.some(model => model.id === request.model)) throw new Error('Model is absent from the configured provider catalog');
    const resolved = await ctx.llm.resolveCallConfig({
      provider: request.provider, model: request.model,
      ...(request.reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(request.reasoningEffort)}),
    });
    const selected = {provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : {reasoningEffort: resolved.reasoningEffort})};
    const ref = selections.get(agent);
    if (!ref) throw new Error('Agent model selection is not mounted');
    agent.ctx.fiber.assertActive();
    agent.session.append('model/selection', selected);
    ref.current = selected;
    await ctx.get('sessionPersistence')?.flush();
    return {selected};
  } catch (error) {
    throw new RemoteError('session/model-unavailable', 'The requested model or reasoning effort is unavailable', {provider: request.provider, model: request.model});
  }
}
