import { newWebSocketRpcSession, type RpcStub } from 'capnweb';
import type { ProcessService } from './process-protocol.ts';

/** One Session's authenticated process connection. A changed container generation never replays work. */
export class ContainerProcessClient {
  private connection: Promise<{api: RpcStub<ProcessService>; socket: WebSocket}> | undefined;
  private generation: string | undefined;
  private epoch: number | undefined;
  private closed = false;
  get ended(): boolean {return this.closed;}
  constructor(private readonly connect: (epoch?: number) => Promise<Response>, private readonly syncFiles: (epoch?: number) => Promise<void>) {}

  async sync(): Promise<void> {
    // Opening selects the requested container size before synchronization can start it.
    await this.open();
    await this.syncFiles(this.epoch);
  }

  private open() {
    if (this.closed) throw new Error('Process connection is closed');
    if (this.connection) return this.connection;
    const pending = (async () => {
      const response = await this.connect(this.epoch);
      const socket = response.webSocket;
      if (!socket) {
        if (response.status === 409) this.closed = true;
        throw new Error(await response.text() || `Process connection failed (${response.status})`);
      }
      const epoch = response.headers.get('x-weft-container-epoch');
      if (epoch !== null) this.epoch = Number(epoch);
      socket.accept();
      const api = newWebSocketRpcSession<ProcessService>(socket);
      socket.addEventListener('close', () => {if (this.connection === pending) this.connection = undefined;});
      socket.addEventListener('error', () => {if (this.connection === pending) this.connection = undefined;});
      const {generation} = await api.info();
      if (this.closed) {api[Symbol.dispose](); socket.close(); throw new Error('Process connection is closed');}
      if (this.generation !== undefined && this.generation !== generation) {
        socket.close(); this.closed = true;
        throw new Error('The workspace container restarted; its processes have ended. Commands were not replayed.');
      }
      this.generation = generation;
      return {api, socket};
    })();
    this.connection = pending;
    return pending;
  }

  async call<T>(operation: (api: RpcStub<ProcessService>) => PromiseLike<T>): Promise<T> {
    for (let attempt = 0;; attempt++) {
      const connection = this.open();
      let socket: WebSocket | undefined;
      try {
        const ready = await connection; socket = ready.socket;
        return await operation(ready.api);
      } catch (error) {
        if (socket && socket.readyState === WebSocket.OPEN) throw error;
        if (this.connection === connection) this.connection = undefined;
        socket?.close();
        if (attempt || this.closed) throw error;
      }
    }
  }

  close(): void {
    this.closed = true;
    void this.connection?.then(({api, socket}) => {api[Symbol.dispose](); socket.close();}).catch(() => {});
    this.connection = undefined;
  }
}
