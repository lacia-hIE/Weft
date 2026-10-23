import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {packageModel} from './helpers/package-model.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation, Artifact} from '../packages/package-install/src/contracts.ts';
import {artifactKey} from '../packages/package-install/src/contracts.ts';

test('original bundle installs through native manager, applies patches, runs standard tools and restores with exact approval', {timeout: 150000}, async () => {
  const fixture = packageFixture({files: {'host.js': `import {defineTool} from '@deepseek-ai/dsh-tools';export default class Counter {static inject=['fs','tools'];static Config={'~standard':{version:1,vendor:'fixture',validate:value=>({value:{...value,value:'validated:'+value.value}})}};constructor(ctx,config){ctx.tools.register(defineTool({name:'package_save',description:'Save bundle configuration',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>{const target=await ctx.fs.resolve(config.filename);await ctx.fs.writeText(target,config.value);return {saved:true}}}))}}`}}), model = packageModel(); let builds=0;
  const directory = await mkdtemp(join(tmpdir(),'weft-native-bundle-'));
  const options: NonNullable<Parameters<typeof createRuntime>[1]> = {packages:true,
    bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'package-fixture',DEEPSEEK_BASE_URL:'https://package-model.test/anthropic'},
    outbound:async (request, mf) => {
      if (new URL(request.url).hostname==='package-model.test') return model.outbound(request,mf);
      return request.url===fixture.manifest.dist.tarball ? new Response(fixture.bytes) : Response.json(fixture.manifest);
    }, packageBuilder:async request=>{builds++;return Response.json(await buildPackage(JSON.parse(await request.text())));},
  };
  let runtime=createRuntime(directory,options); const api=nativeClient(()=>runtime);
  const base=`/v1/tenants/${tenantId('alpha')}/environments/default`;
  const operation=async (body?:object)=>runtime.dispatchFetch(url('alpha',base+'/native/package-installations'),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const installed=async()=> (await (await operation()).json() as {installations:Installation[]}).installations[0]!;
  const run=async(sessionId:string)=>{
    const follow=await api.follow(sessionId);await follow.next();
    try {await api.call('session/prompt',{request:{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'SAVE_PACKAGE '+crypto.randomUUID()}]}});for(;;){const frame=await follow.next();if(frame.type==='event'&&frame.event.type==='turn/end')break;}}
    finally{await follow.close();}
  };
  try {
    const receipt=crypto.randomUUID();
    const result=await api.call<{application:string}>('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`,options:{requestId:receipt}});
    assert.equal(result.application,'applied'); const row=await installed();assert.equal(row.approved,false);
    const asset=base+`/native/package-assets/${row.digest}/client.js?name=${encodeURIComponent(row.name)}`;
    assert.equal((await runtime.dispatchFetch(url('alpha',asset))).status,409);
    const artifact=await (await operation({operation:'review',name:row.name,digest:row.digest})).json() as Artifact;
    assert.deepEqual(artifact.lock,fixture.input.lock);assert.equal((artifact.rows[0]?.config as {value:string}).value,'from-patch');
    assert.equal((await operation({operation:'approve',name:row.name,digest:'0'.repeat(64)})).status,409);
    assert.equal((await runtime.dispatchFetch(url('alpha',base+'/native/package-installations'),{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:JSON.stringify({operation:'approve',name:row.name,digest:row.digest})})).status,403);
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest})).status,200);
    assert.equal((await runtime.dispatchFetch(url('alpha',asset))).status,200);
    assert.equal((await runtime.dispatchFetch(url('beta',asset.replace(tenantId('alpha'),tenantId('beta'))))).status,409);
    await api.call('session/create',{request:{sessionId:'native-package'}});await run('native-package');
    let file=await runtime.dispatchFetch(url('alpha',base+'/workspaces/default/files?path=/workspace/package-result.txt'));
    assert.equal(file.status,200,JSON.stringify(model.observations));assert.match(await file.text(),/validated:from-patch/);
    await runtime.dispose();runtime=createRuntime(directory,options);
    await run('native-package');assert.equal((await installed()).approved,true);
    await operation({operation:'install',spec:`${fixture.name}@${fixture.version}`,requestId:receipt});assert.equal(builds,1);
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...artifact.permissions,tools:false,client:false}})).status,200);
    await run('native-package');
    const afterRevocation=JSON.parse(model.observations.at(-1)!) as {tools?:{name:string}[]};
    assert.ok(!afterRevocation.tools?.some(tool=>tool.name==='package_save'),'Reduced grants must unload previously registered tools at the next turn');
    await api.call('pluginManager/setBundleEnabled',{name:row.name,enabled:false});assert.equal((await runtime.dispatchFetch(url('alpha',asset))).status,409);
    await api.call('pluginManager/removeBundle',{name:row.name});assert.equal((await installed()),undefined);
  } finally {await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});

test('native bundle approval limits writes, rejects unsupported services and keeps optional failures isolated', {timeout:150000},async()=>{
  const fixture=packageFixture({client:false}),model=packageModel();let downloads=0;
  const runtime=createRuntime(undefined,{packages:true,browser:true,
    bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'package-fixture',DEEPSEEK_BASE_URL:'https://package-model.test/anthropic'},
    outbound:async(request,mf)=>{
      if(new URL(request.url).hostname==='package-model.test')return model.outbound(request,mf);
      downloads++;return request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest);
    },packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text()))),
  });
  const api=nativeClient(()=>runtime),base=`/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  try{
    assert.equal((await api.call<{status:string}>('pluginManager/inspect',{spec:'@private/plugin@1.0.0',options:{registry:'https://private.test'}})).status,'refused');assert.equal(downloads,0);
    const result=await api.call<{application:string}>('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`});assert.equal(result.application,'applied');
    const row=(await(await runtime.dispatchFetch(url('alpha',base+'/package-installations'))).json() as {installations:Installation[]}).installations[0]!;
    const approved=await runtime.dispatchFetch(url('alpha',base+'/package-installations'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'approve',name:row.name,digest:row.digest,permissions:{files:'read',tools:true,timer:false,client:false}})});assert.equal(approved.status,200);
    await api.call('session/create',{request:{sessionId:'readonly-package'}});
    const follow=await api.follow('readonly-package');await follow.next();await api.call('session/prompt',{request:{sessionId:'readonly-package',requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'SAVE_PACKAGE_READONLY'}]}});
    for(;;){const frame=await follow.next();if(frame.type==='event'&&frame.event.type==='turn/end')break;}await follow.close();
    assert.ok(model.observations.some(body=>body.includes('permission denied')),JSON.stringify(model.observations));
    const bucket=await runtime.getR2Bucket('PLUGIN_ARTIFACTS','alpha');await bucket.delete(artifactKey({tenantId:tenantId('alpha'),environmentId:'default'},row.digest));
    await api.call('session/create',{request:{sessionId:'missing-artifact'}});assert.ok((await api.call<unknown[]>('commands/list',{agentId:'missing-artifact'})).length>0);
  }finally{await runtime.dispose();}
});
