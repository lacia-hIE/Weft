/** Open a DSH Session in the workspace after ensuring the session catalog is loaded. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Thrown by `openKnownSession` when the host Session catalog is not ready or does not list the target Session.
 * The management panel catches it to display a localized error message.
 */
export class SessionNavigationError extends Error {
  constructor(readonly code: 'not-ready' | 'not-listed') { super(code) }
}

/** Select `id` in the workspace once the catalog lists it, unless aborted first. */
export async function openKnownSession(sessions: Pick<ISessions, 'list' | 'refresh'>, id: SessionId, open: (id: SessionId) => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
  if (signal.aborted) return false
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new SessionNavigationError('not-ready')
  if (!list.byId[id]) throw new SessionNavigationError('not-listed')
  open(id)
  return true
}
