/** What a package asks of one root Session it manages. */
export interface ManagedSessionConfig {readonly instructions: string; readonly tools: readonly string[]}
export const MAX_MANAGED_INSTRUCTIONS = 256 * 1024;
export function managedSessionConfig(raw: unknown): ManagedSessionConfig {
  const value = raw as Partial<ManagedSessionConfig> | null;
  if (!value || typeof value.instructions !== 'string' || value.instructions.length > MAX_MANAGED_INSTRUCTIONS || !Array.isArray(value.tools) || value.tools.length > 100
    || value.tools.some(name => typeof name !== 'string' || !name || name.length > 100) || Object.keys(value).length !== 2)
    throw new TypeError('Invalid managed Session configuration');
  return {instructions: value.instructions, tools: [...value.tools]};
}

interface Host {manageSession(sessionId: string, config: ManagedSessionConfig | null): Promise<void>}

/**
 * The plugin face of `weftManagedSessions`. Configuration persists in the owning
 * environment and reaches the Session before its next turn; tool scoping is
 * declared at activation and travels with the tool metadata.
 */
export class WorkerManagedSessions {
  private readonly scoped = new Set<string>();
  constructor(private readonly host: Host) {}
  readonly service = {
    /** Hide these tools from every Session that was not configured with them. */
    scopeTools: (names: readonly string[]) => {
      const added = names.map(String).filter(name => !this.scoped.has(name));
      for (const name of added) this.scoped.add(name);
      return () => {for (const name of added) this.scoped.delete(name);};
    },
    configure: (sessionId: string, config: ManagedSessionConfig) => this.host.manageSession(String(sessionId), managedSessionConfig(config)),
    release: (sessionId: string) => this.host.manageSession(String(sessionId), null),
  };
  isScoped(tool: string): boolean {return this.scoped.has(tool);}
}
