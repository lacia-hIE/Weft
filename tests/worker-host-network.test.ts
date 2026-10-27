import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Response, WebSocketPair} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';

// A channel-style bundle with the standard globals only: a long poll that holds
// its headers past the session egress deadline, a streamed body over 1 MiB, and
// an outbound WebSocket like a gateway connection.
const source = `
export const inject=['fs','storageDomain'];
export async function apply(ctx){
  const state=await ctx.storageDomain.open({name:'gateway',version:1,tables:{},global:{schema:{parse:value=>value},initial:{}}});
  ctx.effect(()=>()=>state.close());
  const write=async(name,text)=>ctx.fs.writeText(await ctx.fs.resolve('/workspace/'+name),text);
  (async()=>{
    const poll=await fetch('https://poll.example.test/getupdates',{method:'POST',body:JSON.stringify({cursor:''})});
    const bytes=(await poll.arrayBuffer()).byteLength;
    await write('poll.txt',poll.status+':'+bytes);
    const socket=new WebSocket('wss://gateway.example.test/socket');
    const received=[];
    socket.addEventListener('open',()=>socket.send('hello'));
    socket.addEventListener('message',event=>{received.push(String(event.data));if(received.length===1)socket.send('x'.repeat(2*1024*1024));});
    socket.addEventListener('close',event=>{void write('socket.txt',received.join(',')+'|'+event.code);});
  })().catch(error=>write('error.txt',String(error?.stack??error)));
}`;

test('an environment Host long-polls, streams large bodies and holds a bounded outbound WebSocket through approved egress', {timeout: 180000}, async () => {
  const fixture = packageFixture({name: '@weft-fixture/gateway', client: false, files: {'host.js': source}});
  let handshakes = 0;
  const runtime = createRuntime(undefined, {packages: true, outbound: async request => {
    const target = new URL(request.url);
    if (target.hostname === 'poll.example.test') {await delay(16_000); return new Response(new Uint8Array(1_200_000));}
    if (target.hostname === 'gateway.example.test') {
      handshakes++;
      assert.equal(request.headers.get('upgrade')?.toLowerCase(), 'websocket');
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      server.accept();
      server.addEventListener('message', event => {if (event.data === 'hello') server.send('welcome');});
      return new Response(null, {status: 101, webSocket: client});
    }
    return request.url === fixture.manifest.dist.tarball ? new Response(fixture.bytes) : Response.json(fixture.manifest);
  }, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api = nativeClient(() => runtime), tenant = tenantId('alpha');
  const base = `/v1/tenants/${tenant}/environments/default`;
  const read = async (name: string) => {const response = await runtime.dispatchFetch(url('alpha', `${base}/workspaces/default/files?path=/workspace/${name}`)); return response.ok ? (await response.json() as {value: {content: string}}).value.content : undefined;};
  const wait = async (name: string) => {
    for (const end = Date.now() + 60_000; Date.now() < end; await delay(250)) {const text = await read(name); if (text !== undefined) return text;}
    throw new Error(`${name} was not written: ${await read('error.txt')}`);
  };
  try {
    await api.call('pluginManager/installBundle', {spec: `${fixture.name}@${fixture.version}`, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal(row.hostScope, 'environment');
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: {...row.permissions, network: true}})})).status, 200);
    assert.equal(await wait('poll.txt'), '200:1200000', 'Environment egress waits for held headers and streams beyond the session buffer');
    assert.equal(await wait('socket.txt'), 'welcome|1009', 'The relay delivers messages and closes on an oversized one');
    assert.equal(handshakes, 1);
    assert.equal(await read('error.txt'), undefined);
  } finally {await runtime.dispose();}
});
