import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type AssistantStreamFrame, type AgentCancelCause } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, type LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

/** Trusted dependencies supplied by the platform; a Context belongs to one session. */
export interface RuntimeOptions {
  sessionId: string;
  persona: string;
  model: { provider: string; model: string };
  adapter: LlmAdapter;
  signal?: AbortSignal;
  cancellationCause?: () => AgentCancelCause;
  onEvent?: (event: SessionEvent) => void;
  onFrame?: (frame: AssistantStreamFrame) => void;
  mountPersistence?: (ctx: Context) => Promise<void>;
  mountTools?: (ctx: Context) => Promise<void>;
}

/** Run the unchanged upstream driver and return its committed event vocabulary. */
export async function runHarnessTurn(options: RuntimeOptions, input: string): Promise<readonly SessionEvent[]> {
  const ctx = new Context();
  try {
    options.signal?.throwIfAborted();
    if (options.onEvent) ctx.on('session/event', (_session, event) => { options.onEvent!(structuredClone(event)); });
    if (options.onFrame) ctx.on('agent/assistant-stream', ({ frame }) => { options.onFrame!(structuredClone(frame)); });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: options.persona });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    if (options.mountPersistence) await options.mountPersistence(ctx);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter([options.model.provider], options.adapter);
    if (options.mountTools) await options.mountTools(ctx);
    const sessionId = SessionId(options.sessionId);
    const agentOptions = options.model;
    const stored = await ctx.get('sessionPersistence')?.stat(sessionId);
    const handle = stored
      ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
      : await ctx.agents.create({ sessionId, agentOptions });
    options.signal?.throwIfAborted();
    const cancel = () => { handle.agent.cancel(options.cancellationCause?.() ?? { kind: 'user' }); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const failures: unknown[] = [];
    ctx.on('agent/error', ({ error }) => { failures.push(error); });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }));
    try { await handle.agent.whenIdle(); } finally { options.signal?.removeEventListener('abort', cancel); }
    await ctx.get('sessionPersistence')?.flush();
    options.signal?.throwIfAborted();
    if (failures.length) throw new AggregateError(failures, 'Harness turn failed');
    return structuredClone(handle.agent.session.snapshotEvents());
  } finally {
    await ctx.fiber.dispose();
  }
}
