import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionReadMetadata } from '../../session-persistence-do/src/index.ts';
import type { SearchPersistencePorts } from './persistence.ts';

/** A Session's owning object stub and the scope it is addressed with. */
export interface SessionTarget { scope: unknown; stub: {fetch(request: Request): Promise<Response>} }

/** Read-only canonical persistence ports over the SessionDOs that own each listed Session. */
export function sessionReadPorts(ids: (signal?: AbortSignal) => Promise<readonly string[]>, target: (sessionId: string) => SessionTarget | Promise<SessionTarget>): SearchPersistencePorts {
  return {
    ids,
    metadata: async (sessionId, signal) => {
      signal?.throwIfAborted(); const session = await target(sessionId);
      const value = await (await session.stub.fetch(new Request('https://session.internal/native-search-metadata', {
        method: 'POST', body: JSON.stringify({scope: session.scope, sessionId, operation: 'native-search-metadata'}), ...(signal ? {signal} : {}),
      }))).json() as {value?: SessionReadMetadata};
      signal?.throwIfAborted(); return value.value;
    },
    page: async (sessionId, offset, end, signal) => {
      signal?.throwIfAborted(); const session = await target(sessionId);
      const value = await (await session.stub.fetch(new Request('https://session.internal/native-search-page', {
        method: 'POST', body: JSON.stringify({scope: session.scope, sessionId, operation: 'native-search-page', offset, end}), ...(signal ? {signal} : {}),
      }))).json() as {events: SessionEvent[]};
      signal?.throwIfAborted(); return value.events;
    },
  };
}
