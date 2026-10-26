import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';

test('the published official GitHub adapter verifies signatures and dispatches to a separate native Worker rule with full Session bootstrap',{timeout:240000},async()=>{
  const adapter=packageFixture({name:'@weft-fixture/github-ingress',client:false,dependencies:{'@deepseek-ai/dsh-webhook-github':'0.2.1-rc.3'},patch:[{insert:[{id:'github',name:'@deepseek-ai/dsh-webhook-github',config:{source:'fixture',path:'/github',secretEnv:'GITHUB_SECRET',maxBodyBytes:4096}}]}]});
  const rule=packageFixture({name:'@weft-fixture/github-rules',client:false,files:{'host.js':`
    import {WebhookRuleId} from '@deepseek-ai/dsh-webhook';
    export const inject=['webhookRuntime'];
    export function apply(ctx){ctx.effect(()=>ctx.webhookRuntime.register({id:WebhookRuleId('worker-review'),kind:'github',run:async(delivery,signal)=>{
      if(delivery.event.name!=='issues')return null;
      if(delivery.event.payload.action==='ignore')return null;
      if(delivery.event.payload.action==='slow')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,5000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
      return {workspacePath:'/workspace',title:'Worker webhook review',prompt:'Review signed GitHub event',agentPreset:'standard',permissionPreset:'read-only'};
    }}));}`}});
  const fixtures=[adapter,rule],cache=new Map<string,{body:Uint8Array;status:number;headers:Record<string,string>}>();
  const runtime=createRuntime(undefined,{packages:true,outbound:async request=>{
    const fixture=fixtures.find(row=>request.url===row.manifest.dist.tarball || request.url.includes(encodeURIComponent(row.name)) || request.url.includes(row.name));
    if(fixture)return request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest);
    if(new URL(request.url).hostname!=='registry.npmjs.org')throw new Error('Unexpected test destination');
    let row=cache.get(request.url);if(!row){const response=await fetch(request.url,{redirect:'manual'});row={body:new Uint8Array(await response.arrayBuffer()),status:response.status,headers:Object.fromEntries(response.headers)};cache.set(request.url,row);}return new Response(row.body,{status:row.status,headers:row.headers});
  },packageBuilder:async request=>{try{return Response.json(await buildPackage(JSON.parse(await request.text())));}catch(error){return Response.json({error:String(error)},{status:422});}}});
  const api=nativeClient(()=>runtime),tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/default/native/package-installations`;
  const operation=(body?:object)=>runtime.dispatchFetch(url('alpha',base),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const installed=async()=> (await(await operation()).json() as {installations:Installation[]}).installations;
  const route=`/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(adapter.name)}/github`;
  const send=(action:string,signature=true,extra:Record<string,string>={})=>{const body=JSON.stringify({action});return runtime.dispatchFetch(url('anonymous',route),{method:'POST',headers:{'content-type':'application/json','x-github-event':'issues','x-github-delivery':crypto.randomUUID(),'x-hub-signature-256':signature?'sha256='+createHmac('sha256','signed-fixture').update(body).digest('hex'):'sha256=invalid',...extra},body});};
  const sessions=async()=> (await api.call<{items:{sessionId:string;title?:string}[]}>('session/list',{_request:{}})).items;
  try{
    await api.call('credentials/set',{ref:'GITHUB_SECRET',value:'signed-fixture'});
    for(const fixture of fixtures){
      const result=await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`});
      const row=(await installed()).find(row=>row.name===fixture.name);assert.ok(row,JSON.stringify(result));
      const response=await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network:false,credentials:fixture===adapter,routes:fixture===adapter}});
      assert.equal(response.status,200,await response.text());
    }
    assert.equal((await send('opened',false)).status,401);
    assert.equal((await send('opened',true,{'x-github-delivery':'one,two'})).status,400);
    assert.equal((await sessions()).length,0);
    assert.equal((await send('ignore')).status,202);await delay(200);assert.equal((await sessions()).length,0);
    const accepted=await send('opened');assert.equal(accepted.status,202,await accepted.text());
    let rows:Awaited<ReturnType<typeof sessions>>=[];
    for(const end=Date.now()+30000;Date.now()<end;await delay(100)){rows=await sessions();if(rows.length)break;}
    assert.equal(rows.length,1,JSON.stringify(await installed()));const sessionId=rows[0]!.sessionId;
    assert.equal(rows[0]!.title,'Worker webhook review');
    const projections=await api.call<{values:{permissions?:{currentValue:string}}}>('session/projections',{request:{sessionId}});assert.equal(projections.values.permissions?.currentValue,'read-only');
    const events=await(await runtime.dispatchFetch(url('alpha',`/v1/tenants/${tenant}/environments/default/sessions/${sessionId}/events`))).text();
    assert.match(events,/"kind":"webhook"/);assert.match(events,/"ruleId":"worker-review"/);assert.match(events,/"provider":"github"/);
    assert.equal((await send('slow')).status,202);await delay(100);
    await api.call('pluginManager/setBundleEnabled',{name:rule.name,enabled:false});await delay(300);assert.equal((await sessions()).length,1,'rule teardown cancels work before it publishes another Session');
    await api.call('pluginManager/setBundleEnabled',{name:adapter.name,enabled:false});assert.equal((await send('opened')).status,404);
  }finally{await runtime.dispose();}
});
