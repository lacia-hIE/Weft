import { Context } from '@deepseek-ai/cordis';
import Sessions, { type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Title from '@deepseek-ai/dsh-session-title';
import Query, { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import type { AssistantStreamFrame, Agent } from '@deepseek-ai/dsh-agent';
import { installModelSelectionProjection } from './model-selection.ts';
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop';
import { inboxProjectionDefinition } from '@weft/upstream/packages/core/agent-loop/src/inbox.ts';
import {agentPresetProjectionDefinition} from '@weft/upstream/packages/preset/agent-preset-registry/src/session.ts';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Todo from '@deepseek-ai/dsh-tool-todo';
import type { SessionSearchRequest, SessionSearchExecContext, SessionSearchPage, SessionSearchHit, SessionEventSearchRequest, SessionEventSearchPage } from '@deepseek-ai/dsh-session-query';
import { SessionHistoryController } from '@weft/upstream/packages/api/session-controller/src/history.ts';
import type {} from '@weft/upstream/packages/subagent/subagent/src/projection.ts';
import { SqliteSessionPersistence } from '../../session-persistence-do/src/index.ts';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import {ComputerFileSystem} from '../../workspace/src/provider.ts';
import type {WorkspaceScope, WorkspaceTransport} from '../../workspace/src/protocol.ts';
import {ComputerAttachmentStore, type AttachmentTransport} from '../../native-attachments/src/store.ts';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';

// The official Web profile also leaves full-text indexing disabled by default.
class DurableSessionQuery extends Query {
  override async searchSessions(_request: SessionSearchRequest, _exec?: SessionSearchExecContext): Promise<SessionSearchPage<SessionSearchHit>> {
    throw new SessionQueryError('Full-text indexing is not enabled', 'SESSION_QUERY_SEARCH_DISABLED');
  }
  override async searchEvents(_request: SessionEventSearchRequest, _exec?: SessionSearchExecContext): Promise<SessionEventSearchPage> {
    throw new SessionQueryError('Full-text indexing is not enabled', 'SESSION_QUERY_SEARCH_DISABLED');
  }
}

/** Reuse native cold-read, projections, pagination, follow and assistant continuity. */
export async function createSessionReader(storage: DurableObjectStorage) {
  const ctx = new Context();
  let active: {agent: Agent; ctx: Context} | undefined;
  let workspace: Promise<void> | undefined;
  // Borrow the actual live Session for native observations. It stays attached
  // to its writer's store; a second attachment would violate native ownership.
  // A cold observation of an active writer would synthesize interrupted-turn
  // closers and make a reconnect cursor advance beyond the durable log.
  class ReaderSessions extends Sessions {
    override get(id: SessionId): Session | undefined {
      return active?.agent.session.id === id ? active.agent.session : super.get(id);
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
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
    ctx.sessionProjections.register(inboxProjectionDefinition);
    ctx.sessionProjections.register(agentPresetProjectionDefinition);
    installModelSelectionProjection(ctx);
    await ctx.plugin(Title, {fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80});
    await ctx.plugin(SqliteSessionPersistence, {storage});
    await ctx.plugin(DurableSessionQuery);
    const history = new SessionHistoryController(ctx, observation => {
      // SessionDO owns execution. A browser history lease does not create a
      // second in-memory Agent or take the durable writer from the turn queue.
      observation[Symbol.dispose]();
    });
    return {
      ctx, history,
      configureWorkspace(config: {scope: WorkspaceScope; transport: WorkspaceTransport; cwd: string; sessionId: string; attachmentTransport: AttachmentTransport; images?: ImagesBinding}): Promise<void> {
        return workspace ??= (async () => {
          await ctx.plugin(ComputerFileSystem, config);
          await ctx.plugin(WorkingDirectory, {defaultDirectory: config.cwd});
          await ctx.plugin(ComputerAttachmentStore, {scope: config.scope, sessionId: config.sessionId, transport: config.attachmentTransport, ...(config.images ? {images: config.images} : {})});
          new ApiSessionList(ctx, 8);
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
