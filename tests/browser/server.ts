import { createSecureServer } from "node:http2";
import { Readable } from "node:stream";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { createRuntime } from "../helpers/miniflare.ts";
import { modelGate } from './model-gate.ts';
import { nativePluginModel } from '../helpers/native-plugin-model.ts';
import {nativeSubagentModel} from '../helpers/native-subagent-model.ts';
import {WebSocketServer,WebSocket as NodeWebSocket} from 'ws';
import {startLocalDsh} from '../helpers/local-dsh.ts';

// Test-only bridge. Production serves directly from the authenticated Worker.
// Native Access identities are supplied by Miniflare, never application headers.
const live = process.env.WEFT_BROWSER_LIVE === "1";
const production = process.env.WEFT_BROWSER_PRODUCTION === "1";
const localDsh=process.env.WEFT_LOCAL_DSH_TEST==='1';
let localFixture:ReturnType<typeof startLocalDsh>|undefined;
const queue = process.env.WEFT_BROWSER_QUEUE === '1' ? modelGate() : undefined;
const plugins = process.env.WEFT_BROWSER_PLUGINS === '1' ? nativePluginModel() : undefined;
const subagents = process.env.WEFT_BROWSER_SUBAGENTS === '1' ? nativeSubagentModel() : undefined;
if (Number(live) + Number(!!queue) + Number(!!plugins) + Number(!!subagents) > 1) throw new Error('Choose one browser model transport');
const key = live
  ? readFileSync(".env", "utf8").match(
      /^DEEPSEEK_API_KEY\s*=\s*["']?([^\r\n"']+)/m,
    )?.[1]
  : undefined;
if (live && !key) throw new Error("Missing live model configuration");
const runtimeDirectory = subagents ? mkdtempSync(join(tmpdir(), 'weft-browser-subagents-')) : undefined;
const modelOptions = key
    ? {
        scriptPath: "dist/worker.js",
        bindings: { MODEL_BACKEND: "deepseek", DEEPSEEK_API_KEY: key },
        browser: true, images: true,
      }
    : queue ? {browser: true, images: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'queue-browser-fixture', DEEPSEEK_BASE_URL: 'https://browser-model.test/anthropic'}, outbound: queue.outbound}
      : plugins ? {browser: true, images: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'plugin-browser-fixture', DEEPSEEK_BASE_URL: 'https://model.test/anthropic'}, outbound: plugins.outbound}
        : subagents ? {browser: true, images: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'subagent-browser-fixture', DEEPSEEK_BASE_URL: 'https://subagent-model.test/anthropic'}, outbound: subagents.outbound}
        : { browser: true, images: true, ...(production ? {scriptPath: "dist/worker.js"} : {}) };
let runtime = createRuntime(runtimeDirectory, modelOptions);
let restarting: Promise<void> | undefined;
await runtime.ready;
// Native Harness opens several concurrent Remote streams. Match CF's HTTP/2
// multiplexing instead of exhausting the browser's six HTTP/1 connections.
const tlsDirectory = mkdtempSync(join(tmpdir(), 'weft-browser-tls-'));
const cert = join(tlsDirectory, 'cert.pem'), keyFile = join(tlsDirectory, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-days', '1'], {stdio: 'ignore'});
const server = createSecureServer({key: readFileSync(keyFile), cert: readFileSync(cert), allowHTTP1: true}, async (request, response) => {
  try {
    if(localDsh&&request.url==='/__test/local-host'){
      const fixture=await localFixture;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({project:fixture?.project,base:fixture?.base,localUrl:fixture?.localUrl,pairingCode:fixture?.pairingCode,bundlePath:fixture?.bundlePath}));return;
    }
    if(localDsh&&request.url==='/__test/local-host/restart'&&request.method==='POST'){
      await(await localFixture)?.restart();response.writeHead(204);response.end();return;
    }
    if (subagents && request.method === 'POST' && request.url === '/__test/subagent-restart') {
      restarting ??= (async () => {await runtime.dispose(); runtime = createRuntime(runtimeDirectory, modelOptions); await runtime.ready;})();
      try {await restarting;} finally {restarting = undefined;}
      response.writeHead(204); response.end(); return;
    }
    await restarting;
    if (subagents && request.url === '/__test/subagent-model') {
      if (request.method === 'POST') subagents.release();
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({calls: subagents.observations.length}));
      return;
    }
    if (queue && request.url === '/__test/model-gate') {
      if (request.method === 'POST') queue.release();
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({calls: queue.calls()}));
      return;
    }
    const streamingUpload = request.method === 'POST' && request.url?.split('?', 1)[0]?.endsWith('/native/api/session/uploadFileBinary');
    const buffers: Buffer[] = [];
    if (!streamingUpload) for await (const part of request) buffers.push(Buffer.from(part));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value && name !== "host" && !name.startsWith(':'))
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    if (headers.has("origin")) headers.set("origin", "http://alpha.local");
    const body = streamingUpload ? Readable.toWeb(request) : Buffer.concat(buffers);
    const abort = new AbortController();
    response.on('close', () => {if (!response.writableEnded) abort.abort();});
    const result = await runtime.dispatchFetch(
      "http://alpha.local" + request.url,
      {
        method: request.method ?? "GET",
        headers: [...headers],
        signal: abort.signal,
        ...(streamingUpload ? {body: body as never, duplex: 'half' as const} : (body as Buffer).length ? {body: body as Buffer} : {}),
      },
    );
    response.writeHead(result.status, Object.fromEntries([...result.headers].filter(([name]) => !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name))));
    if (result.body) {
      const stream = Readable.fromWeb(result.body as never);
      response.on('close', () => { if (!response.writableEnded) stream.destroy(); });
      stream.on('error', () => { response.destroy(); });
      stream.pipe(response);
    } else response.end();
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
const sockets=new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
server.on('upgrade',(request,socket,head)=>{
  void (async()=>{
    const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(value&&key!=='host')headers.set(key,Array.isArray(value)?value.join(', '):String(value));
    if(headers.has('origin'))headers.set('origin','http://alpha.local');
    const result=await runtime.dispatchFetch('http://alpha.local'+request.url,{headers:[...headers]});
    if(result.status!==101||!result.webSocket){socket.write(`HTTP/1.1 ${result.status} Rejected\r\nConnection: close\r\n\r\n`);socket.destroy();return;}
    const remote=result.webSocket;remote.accept();
    sockets.handleUpgrade(request,socket,head,local=>{
      local.on('message',(data,binary)=>{if(binary)local.close(1003);else remote.send(data.toString());});
      remote.addEventListener('message',event=>{if(local.readyState===NodeWebSocket.OPEN)local.send(event.data as string);});
      remote.addEventListener('close',()=>local.close());local.on('close',()=>remote.close());local.on('error',()=>remote.close());
    });
  })().catch(()=>socket.destroy());
});
server.listen(4173, "127.0.0.1", () => {
  if(localDsh){localFixture=startLocalDsh(runtime,cert);void localFixture.catch(error=>console.error(error.message));}
  console.log("Browser verification server ready on 4173");
});
async function close(): Promise<void> {
  if(localFixture)await(await localFixture.catch(()=>undefined))?.stop();
  for(const socket of sockets.clients)socket.terminate();sockets.close();
  server.close();
  await restarting;
  await runtime.dispose();
  rmSync(tlsDirectory, {recursive: true, force: true});
  if (runtimeDirectory) rmSync(runtimeDirectory, {recursive: true, force: true});
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
