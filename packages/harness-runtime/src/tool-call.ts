import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';

/** One tool call outside a model step. */
export interface ToolCallRequest {
  /** Owning Agent: its scoped tools and execution context; absent for a root-scope call. */
  agent?: Agent | undefined;
  callId: string;
  name: string;
  /** Plain JSON arguments; the selected executor parses and validates them as it does a model call. */
  arguments: unknown;
  signal: AbortSignal;
}

/**
 * Run one call as a one-call batch through the scope's selected executor, without
 * committing model-step call/result events.
 * @returns the executor's settled result for that call.
 */
export async function executeToolCall(tools: Context['tools'], request: ToolCallRequest): Promise<ToolExecutionResult> {
  const id = ToolCallId(request.callId);
  const batch = await tools.execute({
    calls: [{type: 'tool-call', id, name: request.name, arguments: JSON.stringify(request.arguments ?? {})}],
    signal: request.signal, ...(request.agent ? {agent: request.agent} : {}),
  });
  const settled = batch.results.find(result => result.callId === id);
  if (!settled) throw new Error('The tool executor settled no result for ' + request.name);
  return settled.result;
}
