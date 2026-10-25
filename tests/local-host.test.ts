import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {EventEmitter,once} from 'node:events';
import {WebSocketServer} from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SUPPORTED_DSH_VERSIONS} from '../packages/local-host-connector/compatibility.mjs';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
// Node-only published plugin: no Node transport is imported by the Worker.
// @ts-expect-error The native plugin is distributed as JavaScript.
import {runTunnel} from '../packages/local-host-connector/transport.mjs';

test('local pairing is single-use, tenant-bound, revocable and survives catalogue restart',{timeout:120_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-local-pairing-'));let runtime=createRuntime(directory);const tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/laptop`;
  const call=(path:string,method='GET',body?:unknown,user='alpha')=>runtime.dispatchFetch(url(user,path),{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const pair=async()=>{const r=await call(base+'/local/pairing','POST',{});assert.equal(r.status,200);return await r.json() as {pairingKey:string};};
  const device=async(key:string,owner=tenant)=>runtime.dispatchFetch(url('anonymous',`/v1/local-hosts/${owner}/laptop/pair`),{method:'POST',headers:{authorization:'Bearer '+key}});
  try{
    assert.equal((await call(`/v1/tenants/${tenant}/environments`,'POST',{id:'laptop',name:'Laptop',kind:'local'})).status,201);
    const key=(await pair()).pairingKey;
    assert.equal((await call(base+'/local/pairing','POST',{},'beta')).status,403);
    assert.equal((await device(key,tenantId('beta'))).status,401);
    const response=await device(key);assert.equal(response.status,200);const {token}=await response.json() as {token:string};
    assert.equal((await device(key)).status,401);
    assert.equal((await call(base+'/native/api/session/list')).status,409);
    assert.equal((await call(base+'/copy','POST',{name:'Copy',requestId:crypto.randomUUID()})).status,409);
    assert.equal((await call(base+'/local/web/')).status,503);
    const connect=(key:string,version:string|null='0.2.1-rc.2',protocol='weft-local-host/1')=>runtime.dispatchFetch(url('anonymous',`/v1/local-hosts/${tenant}/laptop/connect`),{headers:{upgrade:'websocket',authorization:'Bearer '+key,'x-weft-protocol':protocol,...(version===null?{}:{'x-dsh-version':version})}});
    for(const version of [null,'0.2.1-rc.1','0.2.1-rc.4','0.2.1','latest','0.2.1-rc.3+unreviewed'])assert.equal((await connect(token,version)).status,409);
    assert.equal((await connect(token,'0.2.1-rc.3','weft-local-host/3')).status,409);
    for(const version of SUPPORTED_DSH_VERSIONS){const peer=await connect(token,version);assert.equal(peer.status,101);peer.webSocket!.accept();peer.webSocket!.close();}
    const attached=await connect(token);assert.equal(attached.status,101,attached.status===101?'':await attached.text());attached.webSocket!.accept();
    assert.equal((await(await call(base)).json() as {local:{online:boolean}}).local.online,true);
    assert.equal((await call(base+'/local/pairing','DELETE')).status,200);
    assert.equal((await connect(token)).status,401);
    const replacement=(await pair()).pairingKey;assert.equal((await connect(token)).status,401);
    const current=await(await device(replacement)).json() as {token:string};
    await runtime.dispose();runtime=createRuntime(directory);
    const retained=await(await call(base)).json() as {local:{online:boolean;paired:boolean}};assert.deepEqual(retained.local,{online:false,paired:true});
    const resumed=await connect(current.token,'0.2.1-rc.3');assert.equal(resumed.status,101);resumed.webSocket!.accept();resumed.webSocket!.close();
    assert.equal((await call(base,'PATCH',{name:'Renamed laptop'})).status,200);
    assert.equal((await call(base,'DELETE')).status,200);
    await runtime.dispose();runtime=createRuntime(directory);
    assert.equal((await call(base)).status,410);
    assert.equal((await connect(current.token)).status,401);
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});

for(const protocol of ['weft-local-host/1','weft-local-host/2'])test(`${protocol} carries binary uploads, native Mux, cancellation and isolated plugin resources`,{timeout:120_000},async()=>{
  const runtime=createRuntime();const tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/local-wire`;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.cookie,'local-cookie=private');assert.equal(req.headers.authorization,undefined);
    if(req.url==='/api/binary'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));res.setHeader('content-type','application/octet-stream');res.end(Buffer.concat(chunks));
    }else if(req.url?.startsWith('/plugins/')){res.setHeader('content-type','text/javascript');res.setHeader('set-cookie','must-not-leak=1');res.end('local-plugin');}
    else if(req.url==='/api/slow'){req.on('close',()=>res.end());}
    else{res.setHeader('content-type','text/html');res.end('<html><head><base href="./"></head><body>native local frontend</body></html>');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const nativeSockets=new WebSocketServer({noServer:true});
  server.on('upgrade',(request,socket,head)=>{
    assert.equal(request.url,'/api/remote.mux');assert.equal(request.headers.cookie,'local-cookie=private');
    nativeSockets.handleUpgrade(request,socket,head,peer=>peer.on('message',data=>peer.send(data.toString())));
  });
  const post=(path:string,body:unknown)=>runtime.dispatchFetch(url('alpha',path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let control:AbortController|undefined;let task:Promise<unknown>|undefined;
  try{
    assert.equal((await post(`/v1/tenants/${tenant}/environments`,{id:'local-wire',name:'Local',kind:'local'})).status,201);
    const {pairingKey}=await(await post(base+'/local/pairing',{})).json() as {pairingKey:string};
    const {token}=await(await runtime.dispatchFetch(url('anonymous',`/v1/local-hosts/${tenant}/local-wire/pair`),{method:'POST',headers:{authorization:'Bearer '+pairingKey}})).json() as {token:string};
    const response=await runtime.dispatchFetch(url('anonymous',`/v1/local-hosts/${tenant}/local-wire/connect`),{headers:{upgrade:'websocket',authorization:'Bearer '+token,'x-weft-protocol':protocol,'x-dsh-version':'0.2.1-rc.2'}});
    assert.equal(response.status,101,response.status===101?'':await response.text());const ws=response.webSocket!;ws.accept();
    const bridge=Object.assign(new EventEmitter(),{readyState:1,bufferedAmount:0,send:(text:string)=>ws.send(text),terminate:()=>ws.close(),close:()=>ws.close(),ping:()=>{bridge.emit('pong');}});
    ws.addEventListener('message',event=>bridge.emit('message',Buffer.from(String(event.data)),false));ws.addEventListener('close',()=>bridge.emit('close'));
    control=new AbortController();task=runTunnel(bridge,{origin,cookie:'local-cookie=private',signal:control.signal,protocol});
    const bytes=crypto.getRandomValues(new Uint8Array(60_000));const payload=new Uint8Array(180_000);payload.set(bytes);payload.set(bytes,60_000);payload.set(bytes,120_000);
    const binary=await runtime.dispatchFetch(url('alpha',base+'/local/web/api/binary'),{method:'POST',body:payload});assert.equal(binary.status,200);assert.deepEqual(new Uint8Array(await binary.arrayBuffer()),payload);
    const asset=await runtime.dispatchFetch(url('alpha',base+'/local/web/plugins/@example/local/client.js'));assert.equal(await asset.text(),'local-plugin');assert.equal(asset.headers.get('set-cookie'),null);
    assert.equal(asset.headers.get('cache-control'),'private, no-store');
    const revision='a'.repeat(64);
    const cached=await runtime.dispatchFetch(url('alpha',base+'/local/web/plugins/@example/local/client.js?rev='+revision));assert.match(cached.headers.get('cache-control')??'',/private.*immutable/);await cached.body?.cancel();
    const privateApi=await runtime.dispatchFetch(url('alpha',base+'/local/web/api/status?rev='+revision));assert.equal(privateApi.headers.get('cache-control'),'private, no-store');await privateApi.body?.cancel();
    assert.equal((await runtime.dispatchFetch(url('beta',base+'/local/web/plugins/@example/local/client.js?rev='+revision))).status,403);
    const html=await(await runtime.dispatchFetch(url('alpha',base+'/local/web/'))).text();assert.ok(html.includes(`href="${base}/local/web/"`));assert.ok(html.includes('native local frontend'));
    assert.equal((await runtime.dispatchFetch(url('beta',base+'/local/web/'))).status,403);
    const stream=await runtime.dispatchFetch(url('alpha',base+'/local/web/api/remote.mux'),{headers:{upgrade:'websocket'}});assert.equal(stream.status,101);stream.webSocket!.accept();
    const incoming=new Promise<string>(resolve=>stream.webSocket!.addEventListener('message',event=>resolve(String(event.data)),{once:true}));
    const largeFrame=protocol.endsWith('/2')?'汉🙂'.repeat(750_000):'native terminal uplink'+'x'.repeat(180_000);stream.webSocket!.send(largeFrame);assert.equal(await incoming,largeFrame);stream.webSocket!.close();
    const aborted=new AbortController();const pending=runtime.dispatchFetch(url('alpha',base+'/local/web/api/slow'),{signal:aborted.signal});setTimeout(()=>aborted.abort(),50);await pending.catch(()=>{});
    await runtime.dispatchFetch(url('alpha',base+'/local/pairing'),{method:'DELETE'});assert.equal((await runtime.dispatchFetch(url('alpha',base+'/local/web/'))).status,503);
  }finally{control?.abort();await task;for(const socket of nativeSockets.clients)socket.terminate();nativeSockets.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.dispose();}
});
