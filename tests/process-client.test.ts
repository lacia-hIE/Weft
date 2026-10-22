import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {WebSocketServer, WebSocket} from 'ws';
import {RpcTarget, newWebSocketRpcSession} from 'capnweb';
import {ContainerProcessClient} from '../packages/workspace/src/process-client.ts';

test('process connection retries an ambiguous start once, preserves application errors, and refuses a changed container generation', {timeout: 10_000}, async () => {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
  await once(server, 'listening');
  const address = server.address() as {port: number};
  let generation = 'first', connections = 0, executions = 0, drop = true;
  const receipts = new Map<string, {pid: number}>();
  server.on('connection', socket => {
    class Runtime extends RpcTarget {
      info() {return {generation};}
      async start(id: string) {
        if (id === 'invalid') throw Error('invalid specification');
        let receipt = receipts.get(id);
        if (!receipt) {receipt = {pid: ++executions};receipts.set(id, receipt);}
        if (drop) {drop = false;socket.terminate();await new Promise(() => {});}
        return receipt;
      }
    }
    newWebSocketRpcSession(socket as unknown as globalThis.WebSocket, new Runtime());
  });
  const connect = async () => {
    connections++;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    (socket as unknown as {accept(): void}).accept = () => {};
    return {webSocket: socket, headers: new Headers()} as unknown as Response;
  };
  const client = new ContainerProcessClient(connect, async () => {assert.ok(connections > 0, 'the connection selects the container before sync');});
  try {
    await client.sync();
    assert.deepEqual(await client.call(api => api.start('one', {} as never)), {pid: 1});
    assert.equal(executions, 1);assert.equal(connections, 2);
    await assert.rejects(client.call(api => api.start('invalid', {} as never)), /invalid specification/);
    await client.call(api => api.info());assert.equal(connections, 2, 'application errors retain the working connection');
    generation = 'restarted';
    const disconnected = Promise.all([...server.clients].map(socket => once(socket, 'close')));
    for (const socket of server.clients) socket.terminate();
    await disconnected;
    await assert.rejects(client.call(api => api.start('two', {} as never)), /restarted.*not replayed/);
    assert.equal(executions, 1, 'no command runs against the replacement generation');
    await assert.rejects(client.call(api => api.info()), /closed/);
    const replacement = new ContainerProcessClient(connect, async () => {});
    try {assert.equal((await replacement.call(api => api.info())).generation, generation);} finally {replacement.close();}
  } finally {
    client.close();for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
