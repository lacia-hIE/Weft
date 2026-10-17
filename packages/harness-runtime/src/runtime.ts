import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AssistantStreamFrame, type AgentCancelCause } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, type LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionTitle, {SessionTitleInvalidError, normalizeSessionTitle} from '@deepseek-ai/dsh-session-title';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { installModelSelectionProjection, mountModelSelection, selectLiveHarnessModel } from './model-selection.ts';
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types';

/** Trusted dependencies supplied by the platform; a Context belongs to one session. */
export interface RuntimeOptions {
  sessionId: string;
  meta?: { cwd?: string; agentPreset?: string };
  presentation?: boolean;
  requestId?: import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId;
  clientTimeZone?: string;
  promptContent?: readonly {type: 'text'; text: string}[];
  persona: string;
  model: { provider: string; model: string };
  adapter: LlmAdapter;
  signal?: AbortSignal;
  cancellationCause?: () => AgentCancelCause;
  onEvent?: (event: SessionEvent, session: Session) => void;
  onFrame?: (frame: AssistantStreamFrame) => void;
  onAgent?: (agent: Agent, ctx: Context) => void;
  onAgentDisposed?: (agent: Agent) => void;
  onSessionCreated?: (session: Session) => void;
  onSessionDisposed?: (session: Session) => void;
  mountPersistence?: (ctx: Context) => Promise<void>;
  mountTools?: (ctx: Context) => Promise<void>;
  beforeAssembly?: () => Promise<void>;
  defaultModel?: () => import('@deepseek-ai/dsh-agent').ModelSelection;
}

/** Run the unchanged upstream driver and return its committed event vocabulary. */
async function withHarnessSession<T>(options: RuntimeOptions, operation: (ctx: Context, agent: Agent) => Promise<T>): Promise<T> {
  const ctx = new Context();
  let owned: Agent | undefined;
  try {
    options.signal?.throwIfAborted();
    if (options.onEvent) ctx.on('session/event', (session, event) => { options.onEvent!(structuredClone(event), session); });
    if (options.onFrame) ctx.on('agent/assistant-stream', ({ frame }) => { options.onFrame!(structuredClone(frame)); });
    if (options.onSessionCreated) ctx.on('session/created', session => { options.onSessionCreated!(session); });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    if (options.presentation) installModelSelectionProjection(ctx);
    if (options.presentation) await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
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
      : await ctx.agents.create({ sessionId, agentOptions, ...(options.meta ? { meta: options.meta } : {}) });
    owned = handle.agent;
    if (options.presentation) mountModelSelection(ctx, handle.agent, options.defaultModel, options.beforeAssembly);
    if (options.beforeAssembly) handle.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await options.beforeAssembly!();
      return next();
    }, {prepend: true});
    options.signal?.throwIfAborted();
    options.onAgent?.(handle.agent, ctx);
    return await operation(ctx, handle.agent);
  } finally {
    try { await ctx.fiber.dispose(); }
    finally {
      // Root listeners can unwind before their child Agent disposal event.
      // The owner must release its borrowed read handle explicitly.
      if (owned) {
        options.onAgentDisposed?.(owned);
        options.onSessionDisposed?.(owned.session);
      }
    }
  }
}

/** Create or restore the real native Agent/Session without submitting a prompt. */
export async function initializeHarnessSession(options: RuntimeOptions): Promise<void> {
  await withHarnessSession(options, async (ctx, agent) => {
    if (options.presentation && !ctx.sessionTitle.get(agent.session)) await ctx.sessionTitle.refresh(agent.session);
    await ctx.get('sessionPersistence')?.flush();
  });
}

export async function renameHarnessSession(options: RuntimeOptions, title: string): Promise<{title: string; seq: number}> {
  if (!normalizeSessionTitle(title, 80)) throw new RemoteError('session/title-invalid', 'Title must not be empty', {sessionId: SessionId(options.sessionId)});
  return withHarnessSession({...options, presentation: true}, (ctx, agent) => renameLiveHarnessSession(ctx, agent, title));
}

export async function selectHarnessModel(options: RuntimeOptions, selection: ModelSelection): Promise<{selected: ModelSelection}> {
  return withHarnessSession({...options, presentation: true}, (ctx, agent) => selectLiveHarnessModel(ctx, agent, selection));
}

export async function renameLiveHarnessSession(ctx: Context, agent: Agent, title: string): Promise<{title: string; seq: number}> {
  try {
    const accepted = ctx.sessionTitle.rename(agent.session, title);
    await ctx.get('sessionPersistence')?.flush();
    return {title: accepted.title, seq: accepted.eventSeq};
  } catch (error) {
    if (error instanceof SessionTitleInvalidError) throw new RemoteError('session/title-invalid', 'Title must not be empty', {sessionId: agent.session.id});
    throw error;
  }
}

/** Run the unchanged upstream driver and return its committed event vocabulary. */
export async function runHarnessTurn(options: RuntimeOptions, input: string): Promise<readonly SessionEvent[]> {
  return withHarnessSession(options, async (ctx, agent) => {
    const cancel = () => { agent.cancel(options.cancellationCause?.() ?? {kind: 'user'}); };
    options.signal?.addEventListener('abort', cancel, {once: true});
    const failures: unknown[] = [];
    ctx.on('agent/error', ({error}) => { failures.push(error); });
    agent.followup(createUserMessage({content: options.promptContent ? [...options.promptContent] : [{type: 'text', text: input}], source: {kind: 'user', ...(options.requestId !== undefined ? {rpcId: options.requestId} : {}), ...(options.clientTimeZone !== undefined ? {clientTimeZone: options.clientTimeZone} : {})}}));
    try { await agent.whenIdle(); } finally { options.signal?.removeEventListener('abort', cancel); }
    await ctx.get('sessionPersistence')?.flush();
    options.signal?.throwIfAborted();
    if (failures.length) throw new AggregateError(failures, 'Harness turn failed');
    return structuredClone(agent.session.snapshotEvents());
  });
}
