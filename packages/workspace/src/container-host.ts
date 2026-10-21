import { DurableObject } from 'cloudflare:workers';
import { WorkspaceContainerAPI, type ContainerLaunchSpec, type ContainerRuntimeInfo, type IWorkspaceContainerAPI, type WorkspaceRef } from '@cloudflare/computer/backends/container';

/** How long an idle workspace container keeps running before it sleeps; the next command starts it again. */
const IDLE_MS = 10 * 60_000;

/**
 * The Cloudflare Container of one workspace. The configuration language binds
 * every Durable Object by Worker name, and a Durable Object bound that way
 * cannot host a Container, so the container lives in this unbound object
 * (reached through `ctx.exports`) while the workspace itself stays in
 * WorkspaceDO. computerd still connects back to WorkspaceDO through
 * `WorkspaceProxy`, so files and executions remain the workspace's own.
 */
export class WorkspaceContainerDO extends DurableObject {
  private api(): WorkspaceContainerAPI { return new WorkspaceContainerAPI(this.ctx); }
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
  exitInfo() { return this.api().exitInfo(); }
  status() { return this.api().status(); }
  interceptOutboundHttp(host: string, ref: WorkspaceRef): Promise<void> { return this.api().interceptOutboundHttp(host, ref); }
  interceptAllOutboundHttp(ref: WorkspaceRef, token: string): Promise<void> { return this.api().interceptAllOutboundHttp(ref, token); }
  fetchPort(port: number, input: string, init?: {method?: string; headers?: Record<string, string>; body?: string}): Promise<Response> {
    return this.api().fetchPort(port, input, init);
  }
}

type ContainerHostStub = Pick<WorkspaceContainerDO, 'start' | 'restart' | 'exitInfo' | 'status' | 'interceptOutboundHttp' | 'interceptAllOutboundHttp' | 'fetchPort'>;

/**
 * The container host `ContainerBackend` drives, over RPC to the workspace's
 * WorkspaceContainerDO. Abort signals cannot cross RPC: a request's deadline
 * is kept here, and the remote fetch is left to finish on its own.
 */
export function remoteContainerHost(stub: ContainerHostStub): IWorkspaceContainerAPI {
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
    port: unsupported('port') as IWorkspaceContainerAPI['port'],
  };
}
