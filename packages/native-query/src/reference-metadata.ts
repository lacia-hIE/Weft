import {SessionId} from '@deepseek-ai/dsh-session';
import {scheduler} from 'node:timers/promises';
import {titleProjectionDefinition} from '@deepseek-ai/dsh-session-title';
import {subagentIdentityProjectionDefinition} from '@weft/upstream/packages/subagent/subagent/src/projection.ts';
import {applySessionListMetadata} from '@weft/upstream/packages/api/session-controller/src/list.ts';
import type {SessionListMetadata} from '@deepseek-ai/dsh-api-session-controller/types';
import {readSessionMetadata, readSessionEventPage, type SessionReadMetadata} from '../../session-persistence-do/src/index.ts';

interface ReferenceState {
  title: string | null;
  subagent: ReturnType<typeof subagentIdentityProjectionDefinition.stateSchema.parse>;
  list: SessionListMetadata;
}
export interface SessionReferenceSummary {
  blank: boolean;
  title: string | null;
  label?: string;
}
export interface SessionReferenceMetadata extends SessionReadMetadata {
  reference: SessionReferenceSummary;
}

/** Read original projection folds without opening a Session or acquiring its writer.
 * Checkpoints are derived, identity-bound, and only advance through committed events.
 */
export async function readSessionReferenceMetadata(storage: DurableObjectStorage, sessionId: string, signal?: AbortSignal): Promise<SessionReferenceMetadata | undefined> {
  signal?.throwIfAborted();
  const metadata = readSessionMetadata(storage, SessionId(sessionId));
  if (!metadata) return undefined;
  storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_reference_checkpoints (id TEXT PRIMARY KEY, identity TEXT NOT NULL, event_count INTEGER NOT NULL, state TEXT NOT NULL)');
  const identity = JSON.stringify([metadata.header, metadata.inheritedEventCount, titleProjectionDefinition.stateVersion, subagentIdentityProjectionDefinition.stateVersion, 1]);
  const cached = storage.sql.exec<{identity: string; event_count: number; state: string}>('SELECT identity,event_count,state FROM weft_reference_checkpoints WHERE id=?', sessionId).toArray()[0];
  let state: ReferenceState = {title: null, subagent: {}, list: {blank: true, lastPromptAt: null}};
  let offset = 0;
  if (cached?.identity === identity && cached.event_count <= metadata.eventCount) {
    const value = JSON.parse(cached.state) as ReferenceState;
    state = {title: titleProjectionDefinition.stateSchema.parse(value.title), subagent: subagentIdentityProjectionDefinition.stateSchema.parse(value.subagent), list: value.list};
    offset = cached.event_count;
  }
  const start = offset;
  while (offset < metadata.eventCount) {
    signal?.throwIfAborted();
    const events = readSessionEventPage(storage, SessionId(sessionId), offset, metadata.eventCount);
    if (!events.length) throw new Error('Reference checkpoint could not advance through the committed log');
    for (const event of events) {
      state.title = titleProjectionDefinition.apply(state.title, event);
      state.subagent = subagentIdentityProjectionDefinition.apply(state.subagent, event);
      state.list = applySessionListMetadata(state.list, event);
    }
    offset += events.length;
    // Bound each work slice during the first read of an existing large Session.
    if (offset < metadata.eventCount) await scheduler.yield();
  }
  signal?.throwIfAborted();
  if (!cached || cached.identity !== identity || start !== offset) storage.sql.exec(
    'INSERT INTO weft_reference_checkpoints VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,event_count=excluded.event_count,state=excluded.state WHERE identity<>excluded.identity OR event_count<=excluded.event_count',
    sessionId, identity, offset, JSON.stringify(state),
  );
  const label = subagentIdentityProjectionDefinition.wire.view(state.subagent)?.label;
  return {...metadata, reference: {blank: state.list.blank, title: state.title, ...(label === undefined ? {} : {label})}};
}
