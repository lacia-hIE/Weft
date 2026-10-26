import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {setTimeout as delay} from 'node:timers/promises';
import type {Installation} from '../packages/package-install/src/contracts.ts';

// An ordinary bundle, with no Weft declaration, private factory or custom author protocol.
const source = `
export const inject=['fs','storageDomain','sessionController','timer'];
export async function apply(ctx){
  const schema={parse:value=>value};
  const state=await ctx.storageDomain.open({name:'rss_state',version:1,tables:{},global:{schema,initial:{sessionId:null,requestId:null,count:0}}});
  ctx.effect(()=>()=>state.close());
  const deliver=async()=>{
    let value=state.global.get();
    if(!value.sessionId){const created=await ctx.sessionController.create({cwd:'/workspace'});value={sessionId:created.sessionId,requestId:crypto.randomUUID(),count:0};await state.global.set(value);}
    const response=await fetch('https://feeds.example.test/rss');
    if(!response.ok)throw new Error('Feed unavailable');
    const text=await response.text();
    await ctx.sessionController.prompt({sessionId:value.sessionId,requestId:value.requestId,mode:'queue',content:[{type:'text',text}]});
    value={...value,count:value.count+1};await state.global.set(value);
    const file=await ctx.fs.resolve('/workspace/worker-host.txt');await ctx.fs.writeText(file,'delivered:'+value.count);
  };
  ctx.timer.timeout(deliver,1000);
  ctx.timer.timeout(deliver,10000);
}`;

test('environment Worker Host restores native storage and timers, uses approved egress and prompts a native Session without a browser', {timeout: 180000}, async () => {
  const fixture=packageFixture({name:'@weft-fixture/background',client:false,files:{'host.js':source}});
  const directory=await mkdtemp(join(tmpdir(),'weft-background-'));
  let feeds=0;
  const options:NonNullable<Parameters<typeof createRuntime>[1]>={packages:true,outbound:async request=>{
    if(new URL(request.url).hostname==='feeds.example.test'){feeds++;return new Response('Summarize this new RSS entry');}
    return request.url===fixture.manifest.dist.tarball ? new Response(fixture.bytes) : Response.json(fixture.manifest);
  },packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text())))};
  let runtime=createRuntime(directory,options);const api=nativeClient(()=>runtime);
  const scope={tenantId:tenantId('alpha'),environmentId:'default'},base=`/v1/tenants/${scope.tenantId}/environments/default/native/package-installations`;
  const list=async()=> (await (await runtime.dispatchFetch(url('alpha',base))).json() as {installations:Installation[]}).installations;
  const approve=async(row:Installation,network:boolean)=>runtime.dispatchFetch(url('alpha',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network}})});
  const file=async()=>runtime.dispatchFetch(url('alpha',`/v1/tenants/${scope.tenantId}/environments/default/workspaces/default/files?path=/workspace/worker-host.txt`));
  const waitFile=async(count:number)=>{for(const end=Date.now()+35000;Date.now()<end;await delay(200)){const response=await file();if(response.ok&&(await response.text()).includes('delivered:'+count))return;}throw new Error('Background delivery did not finish');};
  try {
    await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`,options:{requestId:crypto.randomUUID()}});
    const row=(await list())[0]!;assert.equal(row.hostScope,'environment');assert.equal(row.permissions.sessions,true);assert.equal(row.permissions.storage,true);
    assert.equal((await approve(row,true)).status,200);
    await waitFile(1);
    assert.equal(feeds,1);
    const sessions=await api.call<{items:{sessionId:string}[]}>('session/list',{request:{}});assert.equal(sessions.items.length,1);
    const sessionId=sessions.items[0]!.sessionId;
    assert.equal((await file()).status,200);
    await runtime.dispose();runtime=createRuntime(directory,options);
    await waitFile(2);assert.equal(feeds,2);
    const again=await api.call<{items:{sessionId:string}[]}>('session/list',{request:{}});assert.equal(again.items.length,1);
    await api.call('pluginManager/setBundleEnabled',{name:row.name,enabled:false});
    const before=feeds;await delay(1200);assert.equal(feeds,before);assert.equal((await list())[0]!.enabled,false);
  } finally {await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});

test('a native bundle owns an explicitly approved webhook route and queues channel messages with native request deduplication', {timeout:120000}, async()=>{
  const fixture=packageFixture({name:'@weft-fixture/channel',client:false,files:{'host.js':`
    export const inject=['webServer','storageDomain','sessionController'];
    export async function apply(ctx){
      const state=await ctx.storageDomain.open({name:'channel',version:1,tables:{},global:{schema:{parse:value=>value},initial:{sessionId:null}}});ctx.effect(()=>()=>state.close());
      let tail=Promise.resolve();
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/events',handler:(req,res)=>{
        const work=tail.then(async()=>{
          if(req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401);res.end();return;}
          let text='';for await(const chunk of req)text+=new TextDecoder().decode(chunk);
          const input=JSON.parse(text);let value=state.global.get();
          if(!value.sessionId){value=await ctx.sessionController.create({});await state.global.set(value);}
          await ctx.sessionController.prompt({sessionId:value.sessionId,requestId:input.id,mode:'queue',content:[{type:'text',text:input.text}]});
          res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify(value));
        });tail=work.catch(()=>{});return work;
      }}));
    }`}});
  const runtime=createRuntime(undefined,{packages:true,outbound:async request=>request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest),packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api=nativeClient(()=>runtime),tenant=tenantId('alpha');
  const route=`/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(fixture.name)}/events`;
  const operation=async(body?:object)=>runtime.dispatchFetch(url('alpha',`/v1/tenants/${tenant}/environments/default/native/package-installations`),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const event={id:crypto.randomUUID(),text:'Channel gateway fixture'};
  const send=(token?:string)=>runtime.dispatchFetch(url('anonymous',route),{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:token}:{}),'cookie':'CF_Authorization=untrusted'},body:JSON.stringify(event)});
  try{
    await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`});
    const row=(await(await operation()).json() as {installations:Installation[]}).installations[0]!;
    assert.equal(row.hostScope,'environment');assert.equal(row.permissions.routes,true);
    assert.equal((await send('Bearer fixture-secret')).status,404);
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network:false,credentials:false,routes:true}})).status,200);
    assert.equal((await send()).status,401);
    const first=await send('Bearer fixture-secret');assert.equal(first.status,202,await first.clone().text());
    const {sessionId}=await first.json() as {sessionId:string};
    const duplicate=await send('Bearer fixture-secret');assert.equal(duplicate.status,202);assert.equal((await duplicate.json() as {sessionId:string}).sessionId,sessionId);
    const reader=await api.follow(sessionId);await reader.next();await reader.close();
    assert.equal((await api.call<{items:unknown[]}>('session/list',{request:{}})).items.length,1);
    await api.call('pluginManager/setBundleEnabled',{name:row.name,enabled:false});assert.equal((await send('Bearer fixture-secret')).status,404);
  }finally{await runtime.dispose();}
});
