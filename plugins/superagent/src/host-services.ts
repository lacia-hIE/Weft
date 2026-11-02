/** The Host services dsh-superagent runs on, as far as it uses them. */
export interface SessionRecord { event?: SessionEvent }
export interface SessionEvent { seq: number; type: string; data?: unknown }
export interface HostSessionController {
  callerSessionId(): string | undefined
  create(request: { sessionId: string; cwd: string; permissionPreset: string }): Promise<{ sessionId: string }>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(request: { sessionId: string; requestId: string; mode: 'queue' | 'steer'; content: { type: 'text'; text: string }[] }): Promise<unknown>
  cancel(request: { sessionId: string }): Promise<unknown>
  follow(request: { address: { kind: 'session'; sessionId: string }; maxMessages?: number }, signal?: AbortSignal): AsyncIterable<{ type: string; records?: readonly SessionRecord[] }>
  list(request: object): Promise<{ groups?: readonly { sessions?: readonly { sessionId: string; running: boolean }[] }[] } & Record<string, unknown>>
  modelCatalog(request?: object): Promise<{ groups: readonly { id: string; models: readonly unknown[] }[] } & Record<string, unknown>>
}
/** The newest events of a Session's log: the opening snapshot of a follow, which is closed at once and leaves the Agent running. */
export async function sessionLog(controller: Pick<HostSessionController, 'follow'>, sessionId: string, maxMessages: number): Promise<SessionEvent[]> {
  for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, maxMessages })) {
    if (frame.type === 'snapshot') return (frame.records ?? []).flatMap(record => record.event ? [record.event] : [])
  }
  return []
}
export interface HostManagedSessions {
  scopeTools(names: readonly string[]): () => void
  configure(sessionId: string, config: { instructions: string; tools: readonly string[] }): Promise<void>
  release(sessionId: string): Promise<void>
}
export interface HostSessionEvents {
  watch(sessionId: string): Promise<void>
  unwatch(sessionId: string): Promise<void>
  onTurnEnded(handler: (event: { sessionId: string; seq: number }) => unknown): () => void
}
export interface HostFs {
  resolve(path: string): Promise<unknown>
  writeText(file: unknown, text: string): Promise<unknown>
  stat(file: unknown): Promise<unknown>
}
