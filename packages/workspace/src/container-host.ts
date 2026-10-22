import { DurableObject } from 'cloudflare:workers';
import { LegacyWorkspaceContainerAPI, type ContainerLaunchSpec, type ContainerRuntimeInfo, type ILegacyWorkspaceContainerAPI, type WorkspaceRef } from '@cloudflare/computer/backends/container-legacy';
import { PROCESS_PATH, PROCESS_PORT } from './process-protocol.ts';

/** How long an idle workspace container keeps running before it sleeps; the next command starts it again. */
const IDLE_MS = 10 * 60_000;
/** How often a running container command renews its host's activity, well inside {@link IDLE_MS}. */
export const CONTAINER_TOUCH_MS = 60_000;
/** The address computerd connects to for the workspace: in the reserved benchmarking range, never a real destination. */
export const CONTAINER_EGRESS_ADDRESS = '198.18.0.1';
/**
 * Longest wait for one request to the container's port. Computer bounds its
 * own startup steps only partly: computerd answers `/connect` once it has
 * reached the workspace, so an unreachable workspace would otherwise hold the
 * command, and the host, forever.
 */
const PORT_REQUEST_MS = 60_000;

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
  private lifecycleTail: Promise<unknown> = Promise.resolve();
  private lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycleTail.then(operation);
    this.lifecycleTail = next.catch(() => {});
    return next;
  }
  private api(): LegacyWorkspaceContainerAPI { return new LegacyWorkspaceContainerAPI(this.ctx); }
  start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.lifecycle(async () => {
      if (await this.ctx.storage.get('weft_stopping') !== undefined) throw new Error('The workspace container is stopping');
      return this.launch(spec);
    });
  }
  private async launch(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const api = this.api();
    const info = await api.start(spec);
    await this.ctx.storage.put('weft_process_secret', info.clientSecret);
    await api.setInactivityTimeout(IDLE_MS);
    return info;
  }
  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.lifecycle(async () => {
      if (await this.ctx.storage.get('weft_stopping') !== undefined) throw new Error('The workspace container is stopping');
      const api = this.api();
      const info = await api.restart(spec);
      await this.ctx.storage.put('weft_process_secret', info.clientSecret);
      await api.setInactivityTimeout(IDLE_MS);
      return info;
    });
  }
  state() {return {available: this.ctx.container !== undefined, running: this.ctx.container?.running === true};}
  beginStop(epoch: number): Promise<void> {
    return this.lifecycle(async () => {await this.ctx.storage.put('weft_stopping', epoch);});
  }
  /** Final synchronization may adopt a running container, but cannot restart a failed one. */
  adoptForStop(epoch: number, spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.lifecycle(async () => {
      if (await this.ctx.storage.get('weft_stopping') !== epoch || !this.ctx.container?.running) throw new Error('The stopped container cannot be started for synchronization');
      return this.launch(spec);
    });
  }
  destroyForStop(epoch: number): Promise<void> {
    return this.lifecycle(async () => {
      if (await this.ctx.storage.get('weft_stopping') !== epoch) throw new Error('Container stop identity changed');
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.delete('weft_process_secret');
    });
  }
  finishStop(epoch: number): Promise<void> {
    return this.lifecycle(async () => {
      if (await this.ctx.storage.get('weft_stopping') === epoch) await this.ctx.storage.delete('weft_stopping');
    });
  }
  /**
   * A request that keeps this host active. The platform's inactivity timeout
   * counts from the host's last request, while commands reach the container
   * over computerd's own connection to the workspace, so the workspace calls
   * this for every container command and while one runs.
   */
  async touch(): Promise<void> { /* The request itself is the activity. */ }
  /** Internal binding-only upgrade; preserve the container WebSocket response unchanged. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== PROCESS_PATH || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', {status: 404});
    const secret = await this.ctx.storage.get<string>('weft_process_secret');
    const owner = request.headers.get('x-weft-process-owner');
    if (!secret || !owner || !/^[\w-]{1,100}$/.test(owner)) return new Response('Process runtime unavailable', {status: 503});
    return this.api().fetchPort(PROCESS_PORT, 'http://process.internal/connect', {
      headers: {upgrade: 'websocket', authorization: `Bearer ${secret}`, 'x-weft-process-owner': owner}, signal: AbortSignal.timeout(PORT_REQUEST_MS),
    });
  }
  exitInfo() { return this.api().exitInfo(); }
  status() { return this.api().status(); }
  interceptOutboundHttp(host: string, ref: WorkspaceRef): Promise<void> { return this.api().interceptOutboundHttp(host, ref); }
  interceptAllOutboundHttp(ref: WorkspaceRef, token: string): Promise<void> { return this.api().interceptAllOutboundHttp(ref, token); }
  fetchPort(port: number, input: string, init?: {method?: string; headers?: Record<string, string>; body?: string}): Promise<Response> {
    // Bounded here too, so a request the container never answers does not keep this host active and its container running.
    return this.api().fetchPort(port, input, {...init, signal: AbortSignal.timeout(PORT_REQUEST_MS)});
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

type ContainerHostStub = Pick<WorkspaceContainerHost, 'start' | 'restart' | 'adoptForStop' | 'exitInfo' | 'status' | 'interceptOutboundHttp' | 'interceptAllOutboundHttp' | 'fetchPort'>;
/** The host methods the workspace itself calls. */
export type ContainerHostActivity = Pick<WorkspaceContainerHost, 'touch' | 'state' | 'beginStop' | 'destroyForStop' | 'finishStop'>;

/**
 * The container host the backend drives, over RPC to the workspace's host
 * object. Abort signals cannot cross RPC: a request's deadline is kept here,
 * and the remote fetch is left to finish on its own.
 */
export function remoteContainerHost(stub: ContainerHostStub, stopping: () => number | undefined = () => undefined): ILegacyWorkspaceContainerAPI {
  const unsupported = (name: string) => () => { throw new Error(`Workspace container hosts do not provide ${name} over RPC`); };
  return {
    start: spec => {const epoch = stopping(); return epoch === undefined ? stub.start(spec) : stub.adoptForStop(epoch, spec);},
    restart: spec => {if (stopping() !== undefined) throw new Error('The workspace container cannot restart while stopping'); return stub.restart(spec);},
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
      const deadline = AbortSignal.any([AbortSignal.timeout(PORT_REQUEST_MS), ...(signal ? [signal] : [])]);
      deadline.throwIfAborted();
      return Promise.race([request, new Promise<never>((_, reject) => deadline.addEventListener('abort', () => {
        reject(signal?.aborted ? signal.reason : new Error(`The workspace container did not answer ${new URL(url).pathname} within ${PORT_REQUEST_MS / 1000}s`));
      }, {once: true}))]);
    },
    port: unsupported('port') as ILegacyWorkspaceContainerAPI['port'],
  };
}
