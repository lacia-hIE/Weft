import { Context } from '@deepseek-ai/cordis';
import Sessions, { type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Title from '@deepseek-ai/dsh-session-title';
import {installDurableSessionQuery} from '../../native-query/src/index.ts';
import type { AssistantStreamFrame, Agent } from '@deepseek-ai/dsh-agent';
import { installModelSelectionProjection } from './model-selection.ts';
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop';
import { inboxProjectionDefinition } from '@weft/upstream/packages/core/agent-loop/src/inbox.ts';
import {agentPresetProjectionDefinition} from '@weft/upstream/packages/preset/agent-preset-registry/src/session.ts';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Todo from '@deepseek-ai/dsh-tool-todo';
import { SessionHistoryController } from '@weft/upstream/packages/api/session-controller/src/history.ts';
import Subagents from '@deepseek-ai/dsh-subagent';
import type {} from '@weft/upstream/packages/subagent/subagent/src/projection.ts';
import { SqliteSessionPersistence } from '../../session-persistence-do/src/index.ts';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import {ComputerFileSystem} from '../../workspace/src/provider.ts';
import type {WorkspaceScope, WorkspaceTransport} from '../../workspace/src/protocol.ts';
import {ComputerAttachmentStore, type AttachmentTransport} from '../../native-attachments/src/store.ts';
import {nativeSessionList} from './session-list.ts';

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
    await installDurableSessionQuery(ctx, storage);
    const history = new SessionHistoryController(ctx, observation => {
      // The physical owner activates its one native host after the snapshot.
      // This read Context never creates an Agent or takes the durable writer.
      const id = observation.header.id;
      observation[Symbol.dispose]();
      promoteRoot?.(id);
    });
    return {
      ctx, history,
      configureWorkspace(config: {scope: WorkspaceScope; transport: WorkspaceTransport; cwd: string; sessionId: string; attachmentTransport: AttachmentTransport; images?: ImagesBinding}): Promise<void> {
        return workspace ??= (async () => {
          await ctx.plugin(ComputerFileSystem, config);
          await ctx.plugin(WorkingDirectory, {defaultDirectory: config.cwd});
          await ctx.plugin(Subagents, {});
          await ctx.plugin(ComputerAttachmentStore, {scope: config.scope, sessionId: config.sessionId, transport: config.attachmentTransport, ...(config.images ? {images: config.images} : {})});
          nativeSessionList(ctx);
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
