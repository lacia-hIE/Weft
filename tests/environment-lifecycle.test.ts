import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout} from 'node:timers/promises';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {EnvironmentRecord} from '../packages/control-plane/src/contracts.ts';

test('environment rename, pause recovery, resume and deletion preserve isolation and survive restart',{timeout:180_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-lifecycle-'));
  const options={browser:true,configureModel:false,scriptPath:'dist/environment-storage-worker.js',packages:true};
  let runtime=createRuntime(directory,options);
  const tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments`,environment='lifecycle';
  const request=(path:string,method='GET',body?:unknown)=>runtime.dispatchFetch(url('alpha',base+path),{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  const fixture=async(kind:'session'|'workspace'|'environment',action?:string,environmentId=environment,workspaceId='default')=>{
    const response=await runtime.dispatchFetch(url('alpha','/_fixture/lifecycle'),{method:'POST',body:JSON.stringify({kind,action,scope:{tenantId:tenant,environmentId,sessionId:'history',workspaceId}})});
    assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<{tables:string[];lifecycle:{mode:string;operation:number};alarm:number|null}>;
  };
  const wait=async(status:string,error=false)=>{
    for(let i=0;i<600;i++){
      const response=await request('/'+environment);if(status==='deleted'&&response.status===410)return;
      const record=await response.json() as EnvironmentRecord;
      if(error&&record.lifecycle?.error)return record;
      if(record.status===status && !error)return record;
      if(record.lifecycle?.error && !error)throw new Error(record.lifecycle.error);
      await setTimeout(50);
    }
    throw new Error('Lifecycle did not reach '+status);
  };
  const restart=async()=>{await runtime.dispose();runtime=createRuntime(directory,options);};
  try {
    assert.equal((await request('','POST',{id:environment,name:'Development'})).status,201);
    const api=nativeClient(()=>runtime,environment);
    await api.call('credentials/set',{ref:'LIFECYCLE_KEY',value:'private-secret'});
    await api.call('settings/update',{ns:'agent-loop',patch:{maxParallelToolCalls:3}});
    await api.call('session/create',{request:{sessionId:'history'}});
    for(const workspace of ['default','extra'])assert.equal((await request(`/${environment}/workspaces/${workspace}/files`,'PUT',{path:'/workspace/kept.txt',content:workspace,expectedVersion:null})).status,200);
    const bucket=await runtime.getR2Bucket('PLUGIN_ARTIFACTS','alpha');
    const owned=`packages/${encodeURIComponent(JSON.stringify({tenantId:tenant,environmentId:environment}))}/fixture`;
    const other=`packages/${encodeURIComponent(JSON.stringify({tenantId:tenant,environmentId:'default'}))}/fixture`;
    await bucket.put(owned,'private-artifact');await bucket.put(other,'other-artifact');
    assert.equal((await request(`/${environment}`,'PATCH',{name:'Renamed environment'})).status,200);
    assert.equal((await request(`/${environment}`,'PATCH',{name:' '})).status,400);
    await fixture('session','alarm');
    await fixture('workspace','fail-freeze');
    assert.equal((await request(`/${environment}/lifecycle`,'POST',{action:'suspend'})).status,202);
    const interrupted=await wait('pausing',true);assert.match(interrupted!.lifecycle!.error!,/Injected pause interruption/);
    assert.equal((await request(`/${environment}/state`)).status,409,'warm entry cannot bypass closure');
    await restart();
    assert.equal((await request(`/${environment}/lifecycle`,'POST',{action:'suspend'})).status,202);
    await wait('paused');
    assert.equal((await fixture('session')).alarm,null);assert.equal((await fixture('workspace')).lifecycle.mode,'suspended');
    assert.equal((await request(`/${environment}/native/api/session.list`,'POST',{})).status,409);
    assert.equal((await request(`/${environment}/workspaces/default/files`,'PUT',{path:'/workspace/late.txt',content:'late',expectedVersion:null})).status,409);
    await restart();
    assert.equal((await (await request(`/${environment}`)).json() as EnvironmentRecord).name,'Renamed environment');
    assert.equal((await request(`/${environment}`,'PATCH',{name:'Renamed while paused'})).status,200);
    assert.equal((await request(`/${environment}/lifecycle`,'POST',{action:'resume'})).status,202);
    await wait('ready');
    assert.ok((await fixture('session')).alarm!>Date.now());
    assert.match(JSON.stringify(await api.call('credentials/describe',{refs:['LIFECYCLE_KEY']})),/"configured":true/);
    assert.match(JSON.stringify(await api.call('session/list',{})),/history/);
    for(const workspace of ['default','extra']){
      const file=await (await request(`/${environment}/workspaces/${workspace}/files?path=/workspace/kept.txt`)).json() as {value:{content:string}};
      assert.equal(file.value.content,workspace);
    }
    assert.equal((await request('/default','DELETE')).status,409);
    assert.equal((await request(`/${environment}`,'DELETE')).status,202);await wait('deleted');
    assert.equal((await request(`/${environment}`,'DELETE')).status,200,'delete is idempotent');
    assert.equal((await request(`/${environment}/state`)).status,410);
    assert.equal((await request('','POST',{id:environment,name:'reused'})).status,409);
    for(const kind of ['environment','workspace','session'] as const){const inspected=await fixture(kind);assert.equal(inspected.lifecycle.mode,'deleted');assert.deepEqual(inspected.tables,['weft_lifecycle']);assert.equal(inspected.alarm,null);}
    assert.deepEqual((await fixture('workspace',undefined,environment,'extra')).tables,['weft_lifecycle']);
    assert.equal(await bucket.get(owned),null);assert.equal(await (await bucket.get(other))!.text(),'other-artifact');
    await restart();
    assert.equal((await request(`/${environment}/state`)).status,410);
    const rows=(await (await request('')).json() as {environments:EnvironmentRecord[]}).environments;
    assert.ok(!rows.some(row=>row.id===environment));
    // The legacy default route is fenced too, while the catalogue remains usable.
    assert.equal((await request('/default/lifecycle','POST',{action:'suspend'})).status,202);
    for(let i=0;i<600;i++){const row=await (await request('/default')).json() as EnvironmentRecord;if(row.status==='paused')break;if(row.lifecycle?.error)throw new Error(row.lifecycle.error);await setTimeout(50);}
    assert.equal((await runtime.dispatchFetch(url('alpha',`/v1/tenants/${tenant}/state`))).status,409);
    assert.equal((await request('')).status,200);
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});
