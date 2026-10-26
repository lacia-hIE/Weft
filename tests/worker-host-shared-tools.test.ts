import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {packageModel} from './helpers/package-model.ts';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';

test('one environment activation supplies native tools to two Agents and revokes tool access without losing background state',{timeout:150000},async()=>{
  const fixture=packageFixture({name:'@weft-fixture/shared-tools',client:false,files:{'host.js':`
    import {defineTool} from '@deepseek-ai/dsh-tools';
    export const inject=['storageDomain','tools','fs'];
    export async function apply(ctx){
      const state=await ctx.storageDomain.open({name:'shared_tools',version:1,tables:{},global:{schema:{parse:value=>value},initial:{activations:0,calls:0}}});ctx.effect(()=>()=>state.close());
      await state.global.set({...state.global.get(),activations:state.global.get().activations+1});
      ctx.tools.register(defineTool({name:'package_save',description:'Use shared background state',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>{
        const value={...state.global.get(),calls:state.global.get().calls+1};await state.global.set(value);
        const file=await ctx.fs.resolve('/workspace/shared-tools.json');await ctx.fs.writeText(file,JSON.stringify(value));return value;
      }}));
    }`}}),model=packageModel();
  const runtime=createRuntime(undefined,{packages:true,bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'fixture',DEEPSEEK_BASE_URL:'https://package-model.test/anthropic'},outbound:async(request,mf)=>new URL(request.url).hostname==='package-model.test'?model.outbound(request,mf):request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest),packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api=nativeClient(()=>runtime),base=`/v1/tenants/${tenantId('alpha')}/environments/default`;
  const operation=(body?:object)=>runtime.dispatchFetch(url('alpha',base+'/native/package-installations'),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const turn=async(sessionId:string)=>{const follow=await api.follow(sessionId);await follow.next();try{await api.call('session/prompt',{request:{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'SAVE_PACKAGE '+crypto.randomUUID()}]}});for(;;){const frame=await follow.next();if(frame.type==='event'&&frame.event.type==='turn/end')break;}}finally{await follow.close();}};
  try{
    await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`});
    const row=(await(await operation()).json() as {installations:Installation[]}).installations[0]!;
    assert.equal(row.hostScope,'environment');assert.equal(row.permissions.tools,true);
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network:false}})).status,200);
    for(const sessionId of ['shared-a','shared-b']){await api.call('session/create',{request:{sessionId}});await turn(sessionId);}
    const read=async()=>JSON.parse((await(await runtime.dispatchFetch(url('alpha',base+'/workspaces/default/files?path=/workspace/shared-tools.json'))).json() as {value:{content:string}}).value.content) as {activations:number;calls:number};
    assert.deepEqual(await read(),{activations:1,calls:2});
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,tools:false,network:false}})).status,200);
    await turn('shared-a');assert.equal((await read() as {calls:number}).calls,2);
    const after=(await(await operation()).json() as {installations:Installation[]}).installations[0]!;
    assert.equal(after.enabled,true,'the background package remains active with tool exposure denied');
    const request=JSON.parse(model.observations.at(-1)!);assert.ok(!request.tools.some((tool:{name:string})=>tool.name==='package_save'));
  }finally{await runtime.dispose();}
});
