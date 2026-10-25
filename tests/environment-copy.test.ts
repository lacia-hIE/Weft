import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {styledPackageFixture} from './helpers/package-fixture.ts';
import type {Installation,Artifact} from '../packages/package-install/src/contracts.ts';
import type {EnvironmentRecord,TenantState} from '../packages/control-plane/src/contracts.ts';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';

test('environment copying keeps a fixed file/configuration cut, resumes after failure and restart, and excludes history and credentials',{timeout:240_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-copy-'));
  const options={browser:true,configureModel:false,scriptPath:'dist/environment-storage-worker.js'};
  let runtime=createRuntime(directory,options);
  const base=`/v1/tenants/${tenantId('alpha')}/environments`;
  const source=nativeClient(()=>runtime);
  const requestId=crypto.randomUUID();
  const request=(path:string,method='GET',body?:unknown)=>runtime.dispatchFetch(url('alpha',base+path),{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  const fixture=(environmentId:string,operation:string)=>runtime.dispatchFetch(url('alpha','/_fixture/workspace-copy'),{method:'POST',body:JSON.stringify({scope:{tenantId:tenantId('alpha'),environmentId,workspaceId:'default'},operation})});
  const wait=async(status:string)=>{
    for(let i=0;i<1200;i++){
      const row=await (await request('/'+requestId)).json() as EnvironmentRecord;
      if(row.status===status)return row;
      if(row.status==='failed' && status!=='failed')throw new Error(row.copy?.error);
      await setTimeout(50);
    }
    throw new Error('Environment copy did not settle');
  };
  try {
    const large=await runtime.dispatchFetch(url('alpha','/_fixture/environment-storage'),{method:'POST',body:JSON.stringify({scope:{tenantId:tenantId('alpha'),environmentId:'default'},operation:'copy-snapshot-storage'})});
    assert.deepEqual(await large.json(),{equal:true,removed:true},'large Unicode configuration snapshots survive SQLite row boundaries');
    await source.call('settings/update',{ns:'agent-loop',patch:{maxParallelToolCalls:3}});
    await source.call('credentials/set',{ref:'COPY_KEY',value:'source-only-secret'});
    await source.call('session/create',{request:{sessionId:'source-history'}});
    const initial=await (await request('/default/state')).json() as TenantState;
    const minimal=initial.agents.find(row=>row.spec.id==='minimal')!;
    assert.equal((await request('/default/agents','POST',{spec:{...minimal.spec,id:'project-preset',name:'Project preset'},expectedRevision:0})).status,200);
    await source.call('settings/update',{ns:'agent-preset-registry',patch:{selectedDefault:'project-preset'}});
    assert.equal((await request('/default/client-plugins','POST',{id:'copy-panel',name:'Copy panel',source:'export function apply(ctx) {}'})).status,200);
    await fixture('default','seed');await fixture(requestId,'fail');
    const workspace=await source.call<{workspace:{workspaceId:string}}>('workspace/create',{request:{path:'/workspace/project'}});
    await source.call('workspace/rename',{request:{workspaceId:workspace.workspace.workspaceId,title:'Project workspace'}});
    const first=await request('/default/copy','POST',{name:'Project copy',requestId});
    assert.equal(first.status,202,await first.clone().text());
    assert.equal((await request('/'+requestId+'/state')).status,409,'draft is not usable');
    const failed=await wait('failed');assert.match(failed.copy!.error!,/Injected copy interruption/);
    assert.equal((await request('/default/copy','POST',{name:'Different name',requestId})).status,409);
    assert.equal((await runtime.dispatchFetch(url('alpha',base.replace(tenantId('alpha'),tenantId('beta'))+'/default/copy'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Stolen',requestId:crypto.randomUUID()})})).status,403);
    // After the cut, both source bytes and configuration can change independently.
    await source.call('settings/update',{ns:'agent-loop',patch:{maxParallelToolCalls:7}});
    const oldFile=await (await request('/default/workspaces/default/files?path=/workspace/project/run.sh')).json() as {value:{version:string}};
    assert.equal((await request('/default/workspaces/default/files','PUT',{path:'/workspace/project/run.sh',content:'changed after snapshot',expectedVersion:oldFile.value.version})).status,200);
    await runtime.dispose();runtime=createRuntime(directory,options);
    assert.equal((await request('/default/copy','POST',{name:'Project copy',requestId})).status,202);
    const ready=await wait('ready');assert.equal(ready.copy!.phase,'done');
    const target=nativeClient(()=>runtime,requestId);
    const settings=await target.call<SettingsDescribeValue>('settings/describe',{});
    assert.equal((settings.namespaces.find(row=>row.ns==='agent-loop')!.value as {maxParallelToolCalls:number}).maxParallelToolCalls,3);
    assert.equal(JSON.stringify(await target.call('credentials/describe',{refs:['COPY_KEY']})).includes('"configured":false'),true);
    const state=await (await request('/'+requestId+'/state')).json() as TenantState;
    assert.deepEqual(state.sessions,[]);
    assert.equal(state.agents.find(row=>row.spec.id==='project-preset')!.spec.name,'Project preset');
    assert.equal(state.clientPlugins.find(row=>row.id==='copy-panel')!.enabled,false);
    assert.equal((settings.namespaces.find(row=>row.ns==='agent-preset-registry')!.value as {selectedDefault:string}).selectedDefault,'project-preset');
    const inspected=await (await fixture(requestId,'inspect')).json() as {length:number;first:number;last:number;linkedLength:number;linkedLast:number;empty:number;mode:number;count:number;private:boolean;spill:boolean};
    assert.equal(inspected.length,3*1024*1024+17);assert.equal(inspected.first,0);assert.equal(inspected.last,(inspected.length-1)%251);assert.equal(inspected.mode,0o755);assert.ok(inspected.count>5000);assert.equal(inspected.private,false);assert.equal(inspected.spill,false);
    assert.equal(inspected.linkedLength,inspected.length);assert.equal(inspected.linkedLast,inspected.last);assert.equal(inspected.empty,0);
    const read=await (await request(`/${requestId}/workspaces/default/files?path=/workspace/project/run.sh`)).json() as {value:{content:string;version:string}};
    assert.match(read.value.content,/echo copied/);
    const stream=await target.stream<{type:string;value:{items:{title:string;sessionIds:string[]}[]}}>('workspace/follow',{});
    try {const frame=await stream.next();assert.ok(frame.value.items.some(row=>row.title==='Project workspace'));assert.ok(frame.value.items.every(row=>row.sessionIds.length===0));}finally{await stream.close();}
    assert.equal((await request('/default/copy','POST',{name:'Project copy',requestId})).status,200);
    const list=await (await request('')).json() as {environments:EnvironmentRecord[]};assert.equal(list.environments.filter(row=>row.id===requestId).length,1);
    assert.equal((await request(`/${requestId}/workspaces/default/files`,'PUT',{path:'/workspace/project/run.sh',content:'target only',expectedVersion:read.value.version})).status,200);
    const original=await (await request('/default/workspaces/default/files?path=/workspace/project/run.sh')).json() as {value:{content:string}};assert.equal(original.value.content,'changed after snapshot');
  } finally {await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});

test('copied package artifacts have independent ownership and require a new exact approval',{timeout:120_000},async()=>{
  const fixture=styledPackageFixture();
  const runtime=createRuntime(undefined,{browser:true,configureModel:false,packages:true,
    outbound:async request=>request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest),
    packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text()))),
  });
  const base=`/v1/tenants/${tenantId('alpha')}/environments`,api=nativeClient(()=>runtime),requestId=crypto.randomUUID();
  const operation=(environment:string,body?:object)=>runtime.dispatchFetch(url('alpha',`${base}/${environment}/native/package-installations`),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  try {
    await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`,options:{requestId:crypto.randomUUID()}});
    const row=(await (await operation('default')).json() as {installations:Installation[]}).installations[0]!;
    assert.equal((await operation('default',{operation:'approve',name:row.name,digest:row.digest})).status,200);
    const started=await runtime.dispatchFetch(url('alpha',base+'/default/copy'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Package copy',requestId})});assert.equal(started.status,202);
    let ready=false;
    for(let i=0;i<600;i++){
      const record=await (await runtime.dispatchFetch(url('alpha',base+'/'+requestId))).json() as EnvironmentRecord;
      if(record.status==='failed')throw new Error(record.copy!.error);
      if(record.status==='ready'){ready=true;break;}await setTimeout(50);
    }
    assert.ok(ready);
    const copied=(await (await operation(requestId)).json() as {installations:Installation[]}).installations[0]!;
    assert.equal(copied.digest,row.digest);assert.equal(copied.enabled,false);assert.equal(copied.approved,false);assert.equal(copied.candidate,undefined);assert.equal(copied.previous,undefined);
    await api.call('pluginManager/removeBundle',{name:row.name});
    const review=await operation(requestId,{operation:'review',name:row.name,digest:row.digest});assert.equal(review.status,200);
    const artifact=await review.json() as Artifact;assert.equal(artifact.name,fixture.name);assert.deepEqual(artifact.lock,fixture.input.lock);assert.match(artifact.css!,/weft_/);assert.equal(Object.keys(artifact.assets!).length,1);
    assert.equal((await operation(requestId,{operation:'approve',name:row.name,digest:row.digest})).status,200);
  }finally{await runtime.dispose();}
});
