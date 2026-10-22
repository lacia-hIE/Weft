import { DurableObject } from 'cloudflare:workers';
import { LegacyWorkspaceContainerAPI, type ContainerLaunchSpec, type ContainerRuntimeInfo, type ILegacyWorkspaceContainerAPI, type WorkspaceRef } from '@cloudflare/computer/backends/container-legacy';

/** How long an idle workspace container keeps running before it sleeps; the next command starts it again. */
const IDLE_MS = 10 * 60_000;
/** How often a running container command renews its host's activity, well inside {@link IDLE_MS}. */
export const CONTAINER_TOUCH_MS = 60_000;

/**
 * The Cloudflare Container of one workspace, on the platform-scheduled
 * Container applications this account supports. Each application has one
 * instance type, so each size has its own host class.
 *
 * The configuration language binds every Durable Object by Worker name, and a
 * Durable Object bound that way cannot host a Container, so the container
 * lives in an unbound host (reached through `ctx.exports`) while the workspace
 * itself stays in WorkspaceDO. computerd connects back to WorkspaceDO through
 * `WorkspaceProxy`, so files and executions remain the workspace's own.
 */
class WorkspaceContainerHost extends DurableObject {
  private api(): LegacyWorkspaceContainerAPI { return new LegacyWorkspaceContainerAPI(this.ctx); }
  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const api = this.api();
    const info = await api.start(spec);
    await api.setInactivityTimeout(IDLE_MS);
    return info;
  }
  async restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const api = this.api();
    const info = await api.restart(spec);
    await api.setInactivityTimeout(IDLE_MS);
    return info;
  }
  /**
   * A request that keeps this host active. The platform's inactivity timeout
   * counts from the host's last request, while commands reach the container
   * over computerd's own connection to the workspace, so the workspace calls
   * this for every container command and while one runs.
   */
  async touch(): Promise<void> { /* The request itself is the activity. */ }
  exitInfo() { return this.api().exitInfo(); }
  status() { return this.api().status(); }
  interceptOutboundHttp(host: string, ref: WorkspaceRef): Promise<void> { return this.api().interceptOutboundHttp(host, ref); }
  interceptAllOutboundHttp(ref: WorkspaceRef, token: string): Promise<void> { return this.api().interceptAllOutboundHttp(ref, token); }
  fetchPort(port: number, input: string, init?: {method?: string; headers?: Record<string, string>; body?: string}): Promise<Response> {
    return this.api().fetchPort(port, input, init);
  }
}

export class WorkspaceContainerBasicDO extends WorkspaceContainerHost {}
export class WorkspaceContainerStandard1DO extends WorkspaceContainerHost {}
export class WorkspaceContainerStandard2DO extends WorkspaceContainerHost {}

/** The container sizes an environment may choose, each the export name of its host class. */
export const CONTAINER_HOSTS = {
  'basic': 'WorkspaceContainerBasicDO',
  'standard-1': 'WorkspaceContainerStandard1DO',
  'standard-2': 'WorkspaceContainerStandard2DO',
} as const;

type ContainerHostStub = Pick<WorkspaceContainerHost, 'start' | 'restart' | 'exitInfo' | 'status' | 'interceptOutboundHttp' | 'interceptAllOutboundHttp' | 'fetchPort'>;
/** The host methods the workspace itself calls. */
export type ContainerHostActivity = Pick<WorkspaceContainerHost, 'touch'>;

/**
 * The container host the backend drives, over RPC to the workspace's host
 * object. Abort signals cannot cross RPC: a request's deadline is kept here,
 * and the remote fetch is left to finish on its own.
 */
export function remoteContainerHost(stub: ContainerHostStub): ILegacyWorkspaceContainerAPI {
  const unsupported = (name: string) => () => { throw new Error(`Workspace container hosts do not provide ${name} over RPC`); };
  return {
    start: spec => stub.start(spec),
    restart: spec => stub.restart(spec),
    exitInfo: () => stub.exitInfo(),
    status: () => stub.status(),
    setInactivityTimeout: async () => { /* The host sets its own idle timeout at start. */ },
    interceptOutboundHttp: (host, ref) => stub.interceptOutboundHttp(host, ref),
    interceptAllOutboundHttp: (ref, token) => stub.interceptAllOutboundHttp(ref, token),
    fetchPort: async (port, input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const signal = init?.signal ?? undefined;
      const body = init?.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const request = stub.fetchPort(port, url, {
        ...(init?.method ? {method: init.method} : {}),
        ...(init?.headers ? {headers: Object.fromEntries(new Headers(init.headers))} : {}),
        ...(body === undefined ? {} : {body}),
      });
      if (!signal) return request;
      signal.throwIfAborted();
      return Promise.race([request, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}))]);
    },
    port: unsupported('port') as ILegacyWorkspaceContainerAPI['port'],
  };
}
