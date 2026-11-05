import * as SessionStats from '@deepseek-ai/dsh-session-stats';
import * as SessionTurnOutline from '@deepseek-ai/dsh-session-turn-outline';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Title from '@deepseek-ai/dsh-session-title';
import {installDurableSessionQuery} from '../../native-query/src/index.ts';
import {teamProjectionDefinition} from '@weft/upstream/packages/experimental/agent-team/src/projection.ts';
import type { AssistantStreamFrame, Agent } from '@deepseek-ai/dsh-agent';
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import { inboxProjectionDefinition } from '@weft/upstream/packages/core/agent-loop/src/inbox.ts';
import {agentPresetProjectionDefinition} from '@weft/upstream/packages/preset/agent-preset-registry/src/session.ts';
import {userQuestionProjectionDefinition} from '@weft/upstream/packages/interaction/user-questions/src/projection.ts';
import {goalProjectionDefinition} from '@deepseek-ai/dsh-goal';
import {planProjectionDefinition} from '@deepseek-ai/dsh-plan-mode';
import {tokenUsageProjectionDefinition, contextPressureProjectionDefinition} from '@weft/upstream/packages/llm/token-meter/src/usage-projection.ts';
import {contextBreakdownProjectionDefinition} from '@weft/upstream/packages/llm/token-meter/src/breakdown-projection.ts';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Todo from '@deepseek-ai/dsh-tool-todo';
import { HistoryController } from '@weft/upstream/packages/api/session-controller/src/history/controller.ts';
import { WebController } from '@weft/upstream/packages/api/session-controller/src/web/controller.ts';
import type { SessionFollowRequest, SessionPageRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import Subagents from '@deepseek-ai/dsh-subagent';
import type {} from '@weft/upstream/packages/subagent/subagent/src/projection.ts';
import { SqliteSessionPersistence } from '../../session-persistence-do/src/index.ts';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import {ComputerFileSystem} from '../../workspace/src/provider.ts';
import type {WorkspaceScope, WorkspaceTransport} from '../../workspace/src/protocol.ts';
import {ComputerAttachmentStore, type AttachmentTransport} from '../../native-attachments/src/store.ts';
import {nativeSessionList} from './session-list.ts';
import Commands from '@deepseek-ai/dsh-commands';
import {AuthenticatedFetchRoutes} from '../../native-attachments/src/routes.ts';
import {mountSessionExport} from './session-export.ts';

/** Reuse native cold-read, projections, pagination, follow and assistant continuity. */
export async function createSessionReader(storage: DurableObjectStorage, promoteRoot?: (sessionId: SessionId) => void) {
  const ctx = new Context();
  let active: {agent: Agent; ctx: Context} | undefined;
  let workspace: Promise<void> | undefined;
  // Borrow the actual live Session for native observations. It stays attached
  // to its writer's store; a second attachment would violate native ownership.
  // A cold observation of an active writer would synthesize interrupted-turn
  // closers and make a reconnect cursor advance beyond the durable log.
  class ReaderSessions extends Sessions {
    override get(id: SessionId): Session | undefined {
      return active?.ctx.sessions.get(id) ?? super.get(id);
    }
    override list(): Session[] {
      const sessions = super.list();
      const seen = new Set(sessions.map(session => session.id));
      return [...sessions, ...(active?.ctx.sessions.list() ?? []).filter(session => !seen.has(session.id))];
    }
    override flush(session: Session): Promise<boolean> {
      return active?.ctx.sessions.get(session.id) === session
        ? active.ctx.sessions.flush(session)
        : super.flush(session);
    }
  }
  try {
    await ctx.plugin(ReaderSessions);
    await ctx.plugin(Projections);
    // Install the original fold on the read side too. No Agent or writer is
    // created here; tool execution remains in the actual session host.
    await ctx.plugin(SystemPrompt, {personaPrefix: ''});
    await ctx.plugin(Tools);
    await ctx.plugin(Todo, {allowParallelInProgress: false});
    await ctx.sessionProjections.register(teamProjectionDefinition);
    await ctx.sessionProjections.register(inboxProjectionDefinition);
    await ctx.sessionProjections.register(agentPresetProjectionDefinition);
    // Projections the native root's official services and preset plugins fold; the client reads them here.
    await ctx.sessionProjections.register(userQuestionProjectionDefinition);
    await ctx.sessionProjections.register(goalProjectionDefinition);
    await ctx.sessionProjections.register(planProjectionDefinition);
    await ctx.sessionProjections.register(tokenUsageProjectionDefinition);
    await ctx.sessionProjections.register(contextPressureProjectionDefinition);
    await ctx.sessionProjections.register(contextBreakdownProjectionDefinition);
    await ctx.sessionProjections.register(modelSelectionProjectionDefinition);
    // Profile rows that only register read folds; the native root loads them from the official profile.
    await ctx.plugin(SessionStats);
    await ctx.plugin(SessionTurnOutline);
    // The registry folds turn boundaries and lets the title service activate; this read world creates no Agent.
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(Title, {fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80});
    await ctx.plugin(SqliteSessionPersistence, {storage});
    await installDurableSessionQuery(ctx, storage);
    const passive = new HistoryController(ctx);
    const web = new WebController(ctx, passive, observation => {
      // The physical owner activates its one native host after the snapshot.
      // This read Context never creates an Agent or takes the durable writer.
      const id = observation.header.id;
      observation[Symbol.dispose]();
      promoteRoot?.(id);
    });
    // The original controller's `page` and `follow` Remote methods, over the same passive reads.
    const history = {
      page: (request: SessionPageRequest, signal: AbortSignal) => passive.events(request, signal),
      follow: (request: SessionFollowRequest, signal: AbortSignal) => web.follow(request, signal),
    };
    return {
      ctx, history,
      /** Projection folds owned by services this read world must not compose (they would write Sessions). */
      async registerProjections(definitions: readonly Parameters<typeof ctx.sessionProjections.register>[0][]): Promise<void> { for (const definition of definitions) await ctx.sessionProjections.register(definition); },
      configureWorkspace(config: {scope: WorkspaceScope; transport: WorkspaceTransport; cwd: string; sessionId: string; attachmentTransport: AttachmentTransport; images?: ImagesBinding}): Promise<void> {
        return workspace ??= (async () => {
          await ctx.plugin(ComputerFileSystem, config);
          await ctx.plugin(WorkingDirectory, {defaultDirectory: config.cwd});
          await ctx.plugin(Subagents, {});
          await ctx.plugin(ComputerAttachmentStore, {scope: config.scope, sessionId: config.sessionId, transport: config.attachmentTransport, ...(config.images ? {images: config.images} : {})});
          await ctx.plugin(Commands);
          await ctx.plugin(AuthenticatedFetchRoutes);
          await mountSessionExport(ctx);
          await nativeSessionList(ctx);
        })();
      },
      activeRuntime: () => active,
      created(session: Session): void { ctx.emit('session/created', session); },
      sessionDisposed(session: Session): void { ctx.emit('session/disposed', session); },
      activate(agent: Agent, ctx: Context): void { active = {agent, ctx}; },
      dispose(agent: Agent): void {
        if (active?.agent === agent) active = undefined;
        ctx.emit('agent/disposed', {agent});
      },
      event(session: Session, event: SessionEvent): void { ctx.emit('session/event', session, event); },
      frame(agent: Agent, frame: AssistantStreamFrame): void { ctx.emit('agent/assistant-stream', {agent, frame}); },
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
