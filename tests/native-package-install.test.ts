import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture,styledPackageFixture} from './helpers/package-fixture.ts';
import {packageModel} from './helpers/package-model.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation, Artifact} from '../packages/package-install/src/contracts.ts';
import {artifactKey} from '../packages/package-install/src/contracts.ts';

test('original bundle installs through native manager, applies patches, runs standard tools and restores with exact approval', {timeout: 150000}, async () => {
  const fixture = packageFixture({files: {'host.js': `
    import {defineTool} from '@deepseek-ai/dsh-tools';
    import {Service} from '@deepseek-ai/cordis';
    export default class Counter {
      static inject=['fs','tools'];
      static Config={'~standard':{version:1,vendor:'fixture',validate:value=>({value:{...value,value:'validated:'+value.value}})}};
      constructor(ctx,config){this.ctx=ctx;this.config=config;}
      [Service.init](){
        const {ctx,config}=this;
        ctx.tools.register(defineTool({name:'package_save',description:'Save bundle configuration',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>{
          const target=await ctx.fs.resolve(config.filename);
          await ctx.fs.writeText(target,config.value);
          return {saved:true};
        }}));
      }
    }`}}), model = packageModel(); let builds=0;
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
    assert.equal((await runtime.dispatchFetch(url('alpha',asset))).status,409);
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

test('updates preserve the running bundle, reapprove exact assets, roll back failed Hosts and survive restart', {timeout:240000}, async()=>{
  const fixtures=[styledPackageFixture('1.2.3'),styledPackageFixture('1.2.4'),
    packageFixture({version:'1.2.5',files:{'host.js':"export function apply(){throw new Error('Broken update fixture')}"}}),
    packageFixture({version:'1.2.6',files:{'client.js':"import missing from 'missing-dependency';export function apply(){return missing}"}})];
  const model=packageModel(),directory=await mkdtemp(join(tmpdir(),'weft-package-updates-'));
  let buildCount=0;
  const options:NonNullable<Parameters<typeof createRuntime>[1]>={packages:true,
    bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'package-fixture',DEEPSEEK_BASE_URL:'https://package-model.test/anthropic'},
    outbound:async(request,mf)=>{
      if(new URL(request.url).hostname==='package-model.test')return model.outbound(request,mf);
      const tarball=fixtures.find(fixture=>fixture.manifest.dist.tarball===request.url);
      if(tarball)return new Response(tarball.bytes);
      const manifest=fixtures.find(fixture=>request.url.endsWith('/'+fixture.version));
      return manifest?Response.json(manifest.manifest):new Response(null,{status:404});
    },packageBuilder:async request=>{buildCount++;try{return Response.json(await buildPackage(JSON.parse(await request.text())));}catch(error){return Response.json({error:String(error)},{status:422});}},
  };
  let runtime=createRuntime(directory,options);const api=nativeClient(()=>runtime),name=fixtures[0]!.name;
  const base=`/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  const operation=(body?:object)=>runtime.dispatchFetch(url('alpha',base+'/package-installations'),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const selected=async()=>(await (await operation()).json() as {installations:Installation[]}).installations[0]!;
  const install=async(version:string)=>api.call<{application:string}>('pluginManager/installBundle',{spec:`${name}@${version}`,options:{requestId:crypto.randomUUID()}});
  const approve=(digest:string)=>operation({operation:'approve',name,digest});
  const asset=(digest:string,path:string,environment='default')=>runtime.dispatchFetch(url('alpha',base.replace('/default/','/'+environment+'/')+`/package-assets/${digest}/${path}`));
  const run=async()=>{
    const stream=await api.follow('package-updates');await stream.next();
    try{await api.call('session/prompt',{request:{sessionId:'package-updates',requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'SAVE_PACKAGE '+crypto.randomUUID()}]}});for(;;){const frame=await stream.next();if(frame.type==='event'&&frame.event.type==='turn/end')break;}}
    finally{await stream.close();}
  };
  try{
    assert.equal((await install('1.2.3')).application,'applied');const original=await selected();
    const review=await (await operation({operation:'review',name,digest:original.digest})).json() as Artifact;
    const image=Object.keys(review.assets!)[0]!;
    assert.equal((await asset(original.digest,image)).status,409);
    assert.equal((await approve(original.digest)).status,200);
    const bytes=await asset(original.digest,image);assert.equal(bytes.status,200);assert.equal(bytes.headers.get('content-type'),'image/svg+xml');assert.match(bytes.headers.get('content-security-policy')!,/sandbox/);assert.match(await bytes.text(),/<svg/);
    assert.equal((await asset(original.digest,'client.css')).headers.get('content-type'),'text/css; charset=utf-8');
    assert.equal((await runtime.dispatchFetch(url('alpha',base+`/package-assets/${original.digest}/${image}`),{method:'HEAD'})).status,200);
    assert.equal((await asset(original.digest,'assets/missing.svg')).status,404);
    assert.equal((await runtime.dispatchFetch(url('beta',base.replace(tenantId('alpha'),tenantId('beta'))+`/package-assets/${original.digest}/${image}`))).status,409);
    await api.call('session/create',{request:{sessionId:'package-updates'}});await run();
    assert.equal((await install('1.2.4')).application,'applied');
    let row=await selected();assert.equal(row.digest,original.digest);assert.equal(row.enabled,true);assert.equal(row.candidate!.approved,false);
    const candidate=row.candidate!;
    assert.equal((await asset(candidate.digest,image)).status,409);
    await runtime.dispose();runtime=createRuntime(directory,options);
    assert.equal((await selected()).candidate!.digest,candidate.digest);
    assert.equal((await approve('0'.repeat(64))).status,409);
    assert.equal((await approve(candidate.digest)).status,200);row=await selected();
    assert.equal(row.version,'1.2.4');assert.equal(row.previous!.digest,original.digest);assert.equal(row.candidate,undefined);
    assert.equal((await asset(original.digest,image)).status,409);
    await run();
    assert.equal((await operation({operation:'rollback',name,digest:original.digest})).status,409);
    assert.equal((await operation({operation:'rollback',name,digest:row.digest})).status,200);
    row=await selected();assert.equal(row.version,'1.2.3');assert.equal(row.candidate!.digest,candidate.digest);
    assert.equal((await approve(candidate.digest)).status,200);await run();
    assert.equal((await install('1.2.5')).application,'applied');row=await selected();const broken=row.candidate!.digest;
    assert.equal(row.version,'1.2.4');assert.equal((await approve(broken)).status,200);
    await run();row=await selected();assert.equal(row.version,'1.2.4');assert.equal(row.approved,true);assert.equal(row.enabled,true);assert.match(row.lastError!,/Host activation failed/);
    assert.equal(row.candidate!.digest,broken);assert.equal(row.candidate!.approved,false);
    assert.equal((await operation({operation:'client-failed',name,digest:broken})).status,200);assert.equal((await selected()).version,'1.2.4','late failures never roll back another version');
    assert.equal((await operation({operation:'discard',name,digest:broken})).status,200);
    assert.equal((await install('1.2.6')).application,'failed');assert.equal((await selected()).version,'1.2.4');assert.equal((await selected()).enabled,true);
    assert.equal(buildCount,4);await run();
    assert.ok(JSON.parse(model.observations.at(-1)!).tools.some((tool:{name:string})=>tool.name==='package_save'),'previous Host is usable on the next turn');
    const current=await selected();
    assert.equal((await operation({operation:'approve',name,digest:current.digest,permissions:{...current.permissions,client:false}})).status,200);
    assert.equal((await asset(current.digest,image)).status,409);
    await api.call('pluginManager/removeBundle',{name});assert.equal((await selected()),undefined);
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});
