import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {supportsAgentRuntime} from '../packages/harness-runtime/src/revision.ts';
import {migratePresetSpec} from '../packages/control-plane/src/preset-migration.ts';
import upstream from '../upstream.lock.json';

/** Sources of DSH 0.2.1-alpha.4 and 0.2.1-rc.2 through rc.5, which 0.2.2-rc.1 no longer runs. */
const retired=['86a402200d95fecef4529d969836f1fe13c6cb0d','687f282e8625c6b8d11ff58211a90524be2e4317','1f81c047fc48fa190a683e469daa699857e9afe8','504a01a9578abc2c6f1fb896b1dc322c9fe24f66','b830ec950faba0a46dda564be3e2d854afed94f1'];
test('only the pinned 0.2.2-rc.1 runtime is admitted',()=>{
  assert.equal(upstream.commit,'66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db');
  assert.ok(supportsAgentRuntime(upstream.commit));
  for(const source of retired)assert.equal(supportsAgentRuntime(source),false,source);
  assert.equal(supportsAgentRuntime('an-earlier-upstream'),false);assert.equal(supportsAgentRuntime('future-unreviewed-runtime'),false);
});

test('a Session retained from 0.2.1-rc.5 keeps its history but no longer runs, while its custom preset moves to rc.1',{timeout:120_000},async()=>{
  const previous='b830ec950faba0a46dda564be3e2d854afed94f1';
  const directory=await mkdtemp(join(tmpdir(),'weft-upstream-'));
  const options={browser:true,scriptPath:'dist/environment-storage-worker.js'};
  let runtime=createRuntime(directory,options);const api=nativeClient(()=>runtime);
  const sessionId='retained-session';
  const fixture=(commit:string)=>runtime.dispatchFetch(url('alpha','/_fixture/session-revision'),{method:'POST',body:JSON.stringify({scope:{tenantId:tenantId('alpha'),environmentId:'default',sessionId},commit})});
  const prompt=async(text:string)=>{
    const stream=await api.follow(sessionId);const snapshot=await stream.next();assert.equal(snapshot.type,'snapshot');
    try {
      await api.call('session/prompt',{request:{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text}]}});
      for(;;){const frame=await stream.next();if(frame.type==='event'&&frame.event.type==='turn/end'){assert.equal((frame.event.data as {reason?:{kind:string}}).reason?.kind,'completed');break;}}
    }finally{await stream.close();}
  };
  const page=async()=>{const stream=await api.follow(sessionId);try{const frame=await stream.next();if(frame.type!=='snapshot')throw new Error('Missing snapshot');return frame.records.map(record=>record.event);}finally{await stream.close();}};
  try {
    await api.call('session/create',{request:{sessionId}});await prompt('BEFORE_UPGRADE');
    const before=await page();assert.ok(before.length>0);
    assert.equal((await fixture(previous)).status,200);
    const scope={tenantId:tenantId('alpha'),environmentId:'default'};
    const response=await runtime.dispatchFetch(url('alpha',`/v1/tenants/${scope.tenantId}/environments/default/state`));
    const state=await response.json() as {agents:{spec:{id:string;plugins:unknown[]}}[]};
    const spec=state.agents.find(row=>row.spec.id==='minimal')!.spec;
    await runtime.dispatchFetch(url('alpha','/_fixture/environment-storage'),{method:'POST',body:JSON.stringify({scope,operation:'seed-presets',document:JSON.stringify([{revision:2,publishedAt:new Date(0).toISOString(),upstream:previous,spec:{...spec,id:'retained-preset',name:'Retained preset'}}])})});
    await runtime.dispose();runtime=createRuntime(directory,options);
    const rejected=await api.raw('session/prompt',{request:{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'must reject'}]}});
    assert.equal(rejected.result.ok,false);
    // The environment's own preset is republished for this runtime; only the old Session stays bound to rc.5.
    await api.call('session/create',{request:{sessionId:'custom-preset-session',agentPreset:'retained-preset'}});
    assert.deepEqual((await page()).slice(0,before.length),before);
  }finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
});

test('presets published under 0.2.1 drop the merged list_agents row and keep subagent model selection',()=>{
  const spec={id:'custom',name:'Custom',persona:'',workspaceId:'default',allowClientPlugins:false,plugins:[
    {id:'tool-subagent-list-agents',config:{}},
    {id:'tool-subagent',config:{provider:'spawn',toolName:'subagent',modelSelectionSettings:true}},
    {id:'tool-subagent-fork',config:{provider:'fork',toolName:'subagent_fork',modelSelectionSettings:false}},
    {id:'tool-todo',config:{}},
  ]};
  assert.deepEqual(migratePresetSpec(spec).plugins,[
    {id:'tool-subagent',config:{provider:'spawn',toolName:'subagent',modelSelection:true,modelDiscovery:true}},
    {id:'tool-subagent-fork',config:{provider:'fork',toolName:'subagent_fork'}},
    {id:'tool-todo',config:{}},
  ]);
  assert.equal(spec.plugins.length,4,'the published revision is not modified');
});
