import {type Context} from '@deepseek-ai/cordis';
import {SessionLogOffset, type SessionId, type SessionHeader, type SessionEvent} from '@deepseek-ai/dsh-session';
import SessionPersistence, {SessionPersistenceRevision, SessionReadOnlyError, SessionHandleClosedError, SessionPersistenceNotFoundError} from '@deepseek-ai/dsh-session-persistence';
import {assertContiguous, validateStoredEvents, type SessionHandle, type SessionAccess, type SessionHandleReadOptions,
  type SessionPersistenceListOptions, type SessionPersistenceOpenOptions, type SessionPersistenceStatOptions} from '@deepseek-ai/dsh-session-persistence';
import {assertSessionHeadersCompatible} from '@deepseek-ai/dsh-session-query';
import type {SessionReadMetadata} from '../../session-persistence-do/src/index.ts';
import {mapConcurrent} from './concurrent.ts';

export interface SearchPersistencePorts {
  ids(signal?: AbortSignal): Promise<readonly string[]>;
  metadata(id: string, signal?: AbortSignal): Promise<SessionReadMetadata | undefined>;
  page(id: string, offset: number, end: number, signal?: AbortSignal): Promise<readonly SessionEvent[]>;
}

/** Real read-only canonical persistence across the current environment's DOs. */
export class EnvironmentSessionPersistence extends SessionPersistence {
  private metadata = new Map<string, SessionReadMetadata>();
  constructor(ctx: Context, readonly ports: SearchPersistencePorts) {super(ctx);}

  override async list(options?: SessionPersistenceListOptions) {
    const ids = await this.ports.ids(options?.signal);
    const values = await mapConcurrent(ids, id => this.ports.metadata(id, options?.signal), options?.signal);
    this.metadata = new Map(values.filter(value => value !== undefined).map(value => [value.header.id, value]));
    return [...this.metadata.values()].map(value => this.snapshot(value));
  }
  private snapshot(value: SessionReadMetadata) {
    return {header: value.header, eventCount: value.eventCount, formatStatus: 'current' as const, revision: SessionPersistenceRevision(value.revision)};
  }
  override async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    const value = await this.ports.metadata(id, options?.signal);
    return value ? this.snapshot(value) : undefined;
  }
  override async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    if (access !== 'read') throw new SessionReadOnlyError(id, 'open');
    const value = this.metadata.get(id) ?? await this.ports.metadata(id, options?.signal);
    if (!value) throw new SessionPersistenceNotFoundError(id);
    return new EnvironmentReadHandle(this.ports, value);
  }
  override async create(header: SessionHeader): Promise<SessionHandle> {throw new SessionReadOnlyError(header.id, 'create');}
  // This provider owns no write handles and therefore has nothing to flush.
  override async flush(): Promise<void> {}
}

class EnvironmentReadHandle implements SessionHandle {
  readonly access = 'read';
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  private closing: Promise<void> | undefined;
  constructor(private readonly ports: SearchPersistencePorts, metadata: SessionReadMetadata) {
    this.id = metadata.header.id; this.header = metadata.header;
    this.inheritedEventCount = SessionLogOffset(metadata.inheritedEventCount);
  }
  async read(offset = 0, length?: number, options?: SessionHandleReadOptions) {
    if (this.closing) throw new SessionHandleClosedError(this.id, 'read');
    const signal = options?.signal;
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new Error('Invalid session read window');
    const metadata = await this.ports.metadata(this.id, signal);
    if (!metadata) throw new SessionPersistenceNotFoundError(this.id);
    assertSessionHeadersCompatible(this.header, metadata.header);
    if (this.inheritedEventCount !== metadata.inheritedEventCount) throw new Error('Session inherited cut changed');
    const end = Math.min(metadata.eventCount, length === undefined ? metadata.eventCount : offset + length);
    const events: SessionEvent[] = [];
    for (let next = offset; next < end;) {
      signal?.throwIfAborted();
      const page = validateStoredEvents(this.header, [...await this.ports.page(this.id, next, end, signal)]);
      assertContiguous(this.id, page, next);
      if (!page.length || next + page.length > end) throw new Error('Invalid committed session prefix page');
      events.push(...page); next += page.length;
    }
    signal?.throwIfAborted();
    return {eventState: 'detached' as const, events};
  }
  async append(): Promise<void> {throw new SessionReadOnlyError(this.id, 'append');}
  async flush(): Promise<void> {throw new SessionReadOnlyError(this.id, 'flush');}
  close(): Promise<void> {return this.closing ??= Promise.resolve();}
  [Symbol.asyncDispose](): Promise<void> {return this.close();}
}
