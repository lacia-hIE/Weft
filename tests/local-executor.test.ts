import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
// @ts-expect-error Native published plugin is JavaScript.
import {createExecutorController, executorEndpoint} from '../packages/local-host-connector/executor.mjs'

const protocol='weft-executor/1',device=crypto.randomUUID(),ticket='a'.repeat(32),assignment='b'.repeat(32)
const endpoint=`https://weft.example/v1/plugin-hooks/tenant/default/%40weft%2Fdsh-superagent/executor/${device}`
const pairingKey='c'.repeat(64),token='d'.repeat(64)
const waitFor=async(check:()=>boolean)=>{for(let end=Date.now()+5000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,20)))if(check())return;throw new Error('Executor did not settle')}
function native() {
  const listeners=new Map<string, Set<(...args: any[])=>unknown>>(),agents=new Map<string, any>(),sessions=new Map<string,any>(),prompts: any[]=[],cancelled: string[]=[],tools=new Map<string, any>(),permissions:string[]=[],drained:string[]=[],processes:any[]=[]
  const on=(event: string, callback:(...args: any[])=>unknown)=>{const set=listeners.get(event)??new Set();set.add(callback);listeners.set(event,set);return()=>set.delete(callback)}
  const emit=async(event: string,...args: any[])=>{for(const callback of listeners.get(event)??[])await callback(...args)}
  const create=async(input:any)=>{
    const sessionId=input.sessionId??input.resumeSessionId,session=sessions.get(sessionId)??{header:{id:sessionId,...input.meta},snapshotEvents:()=>[]};sessions.set(sessionId,session)
    const localTools=new Map<string,any>(),guards:any[]=[],restrictions:string[][]=[],resources:(()=>void)[]=[]
    const agent:any={id:sessionId,session,status:'idle',inbox:{nextTurn:[],nextStep:[]},localTools,guards,restrictions,
      cancel:()=>{cancelled.push(sessionId);agent.status='idle'},
      ctx:{on:(name:string,callback:any)=>{if(name==='tools/execute')guards.push(callback);return()=>{}},systemPrompt:{section:()=>()=>{}},
        tools:{view:()=>({restrictableNames:new Set(['read','write','subagent','subagent_fork','wait_agent'])}),restrict:({allow}:{allow:string[]})=>{restrictions.push(allow);return()=>{}},register:(tool:any)=>{localTools.set(tool.name,tool);tools.set(tool.name,tool);const dispose=()=>{localTools.delete(tool.name);if(tools.get(tool.name)===tool)tools.delete(tool.name)};resources.push(dispose);return dispose}}}}
    agents.set(sessionId,agent);await input.setup?.(agent.ctx,agent);await emit('agent/created',{agent});return {agent,dispose:async()=>{for(const dispose of resources)dispose();agents.delete(sessionId)}}
  }
  const runtime={drain:async(roots:any[])=>{for(const root of roots){drained.push(root.id);for(const child of [...agents.values()])if(child.session.header.parentSession===root.id){child.cancel();agents.delete(child.id);await emit('subagent/end',{id:child.id,parentSessionId:root.id,runId:child.id,stopReason:'aborted',local:true})}}}}
  const workspaces=new Map<string,{id:string;sessionIds:Set<string>}>()
  const ctx={on,workspaceRegistry:{create:async(path:string)=>{
    const entry=workspaces.get(path)??{id:crypto.randomUUID(),sessionIds:new Set<string>()};workspaces.set(path,entry)
    return {...entry,attachSession:async(id:string)=>{assert.equal(sessions.get(id)?.header.cwd,path);entry.sessionIds.add(id)}}
  }},agents:{get:(id:string)=>agents.get(id),create,resume:create},agentPresets:{resolve:async()=>({id:'local'}),mount:async()=>{}},agentDefaultModel:{currentSelection:()=>({provider:'local',model:'local'})},
    subagents:{drainDescendants:(roots:any[])=>runtime.drain(roots),listDescendants:async(root:string)=>[...sessions.values()].filter(session=>session.header.parentSession===root).map(session=>({kind:'child',id:session.header.id,parentId:root,mode:'continuable'}))},
    permissionPresets:{set:(_session:unknown,preset:string)=>{permissions.push(preset)}},
    jobs:{list:(owner:string)=>processes.filter(item=>item.owner===owner),kill:(id:string)=>{processes.find(item=>item.id===id).status='stopped'},wait:async(id:string)=>processes.find(item=>item.id===id)},
    sessionController:{rename:async()=>{},prompt:async(input:any,signal:AbortSignal)=>{signal.throwIfAborted();prompts.push(input);agents.get(input.sessionId).status='running';await emit('session/event',{id:input.sessionId},{type:'user/message',data:{source:{rpcId:input.requestId}}});await emit('session/event',{id:input.sessionId},{type:'turn/start'})}}}
  const child=async(parentSessionId:string,id='child')=>{const handle=await create({sessionId:id,meta:{parentSession:parentSessionId}});await emit('subagent/start',{id,parentSessionId,runId:id,local:true});return handle.agent}
  return {ctx,prompts,cancelled,tools,permissions,emit,agents,sessions,child,drained,runtime,processes,workspaces}
}

test('local Executor opts in separately, retains native prompt identities, and confirms cancellation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-executor-')),file=join(directory,'executor.json'),root=join(directory,'work'),host=native()
  const command={kind:'run',projectId:'intranet',ticketId:ticket,assignmentId:assignment,name:'fix-example',directory:'/workspace/example',title:'Fix example',instructions:'Work in /workspace/example.',allow:['read','subagent'],
    tools:[{name:'orchestrator_report',description:'Report',parameters:{}}],messages:[{id:'first-input',text:'The original request.',inputs:[]}]}
  let stop=false,syncs=0
  const request=async(address: string,init: RequestInit)=>{
    assert.equal(init.redirect,'error')
    if(address.endsWith('/pair'))return Response.json({protocol,token})
    assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${token}`)
    const body=JSON.parse(String(init.body))
    if(body.projects?.length)assert.deepEqual(body.projects,[{id:'intranet',name:'Internal project'}],'only project summaries leave the computer')
    if(address.endsWith('/tool'))return Response.json({reported:true})
    syncs++
    return Response.json({protocol,commands:[stop?{kind:'stop',ticketId:ticket,assignmentId:assignment}:command],retryAfterMs:1000,
      acknowledged:body.states.map(({ticketId,assignmentId,revision}: any)=>({ticketId,assignmentId,revision}))})
  }
  let controller=createExecutorController({ctx:host.ctx,file,request})
  try {
    await controller.load();assert.equal(controller.snapshot().configured,false)
    await controller.pair({code:JSON.stringify({protocol,endpoint,pairingKey}),root,permissionPreset:'read-only'})
    await waitFor(()=>syncs>0)
    assert.equal(host.prompts.length,0,'pairing never opts the device into execution')
    assert.equal(controller.snapshot().accepting,false)
    await controller.configure({accepting:true,maxWorkers:1,projects:[{id:'intranet',name:'Internal project',repository:directory,verify:'Run repository checks',merge:'',deploy:''}]});await controller.reconnect()
    await waitFor(()=>host.prompts.length===1)
    assert.deepEqual(host.permissions,['read-only'],'only the native plugin injects the locally selected permission service')
    assert.equal(host.prompts[0].requestId,'first-input')
    assert.ok(host.agents.get(host.prompts[0].sessionId).restrictions[0].includes('subagent'))
    await controller.reconnect();await waitFor(()=>syncs>=3)
    assert.equal(host.prompts.length,1,'redelivered commands never repeat accepted prompts')
    assert.equal(host.tools.has('orchestrator_report'),true)
    const sessionId=host.prompts[0].sessionId
    assert.deepEqual([...host.workspaces.get(join(root,'fix-example'))!.sessionIds],[sessionId])
    assert.equal(controller.snapshot().jobs[0].workspaceId,host.workspaces.get(join(root,'fix-example'))!.id)
    await host.tools.get('orchestrator_report').execute({state:'progress'},{callId:'tool-1',signal:new AbortController().signal})
    assert.equal((await stat(file)).mode&0o777,0o600)
    assert.equal(JSON.stringify(controller.snapshot()).includes(token),false)
    const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(stored.token,token)
    assert.equal(stored.jobs[sessionId].project.repository,directory)
    assert.match(stored.jobs[sessionId].instructions,/Run repository checks/)
    assert.match(stored.jobs[sessionId].instructions,/empty merge or deploy field grants no permission/)
    await controller.close();stop=true
    // Simulate the old release: a durable Session with no workspace membership or migration marker.
    host.workspaces.clear();const legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.jobs[sessionId].workspaceId
    await writeFile(file,JSON.stringify(legacy));controller=createExecutorController({ctx:host.ctx,file,request});await controller.load()
    assert.deepEqual([...host.workspaces.get(join(root,'fix-example'))!.sessionIds],[sessionId])
    await waitFor(()=>controller.snapshot().state==='connected')
    assert.equal(host.prompts.length,1,'a connector restart preserves the native inbox receipts')
    stop=true;await controller.reconnect()
    await waitFor(()=>controller.snapshot().jobs[0]?.state==='stopped')
    assert.deepEqual(host.cancelled,[sessionId])
  } finally {await controller.close();await rm(directory,{recursive:true,force:true})}
})

test('Executor pairing rejects unrelated, plaintext and credential-bearing endpoints',()=>{
  assert.equal(executorEndpoint(endpoint),endpoint)
  for(const target of [endpoint.replace('https:','http:'),endpoint+'?token=secret',endpoint.replace('weft.example','user:pass@weft.example'),'https://weft.example/v1/local-hosts/t/e'])assert.throws(()=>executorEndpoint(target))
})

test('connected DSH saves local policy before binding, checks the site and owner, and retains settings across restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-connected-executor-')),file=join(directory,'executor.json'),root=join(directory,'work'),host=native()
  const request=async(address:string)=>address.endsWith('/pair')?Response.json({protocol,token}):Response.json({protocol,commands:[],retryAfterMs:1000})
  const options={ctx:host.ctx,file,request},connection={state:'connected',endpoint:'https://weft.example/v1/local-hosts/tenant/computer'}
  const code=JSON.stringify({protocol,endpoint,pairingKey})
  let controller=createExecutorController(options)
  try{
    await assert.rejects(controller.attach({code},connection),/Configure the task root/)
    await controller.configure({root,agentPreset:'local',permissionPreset:'read-only',accepting:false,maxWorkers:2})
    assert.equal(controller.snapshot().ready,true);assert.equal(controller.snapshot().configured,false)
    await controller.close();controller=createExecutorController(options);await controller.load()
    assert.equal(controller.snapshot().ready,true);assert.equal(controller.snapshot().root,root)
    await assert.rejects(controller.attach({code},{...connection,state:'stopped'}),/Connect this DSH/)
    for(const target of [endpoint.replace('weft.example','other.example'),endpoint.replace('/tenant/','/another-owner/')]){
      await assert.rejects(controller.attach({code:JSON.stringify({protocol,endpoint:target,pairingKey})},connection),/site and owner/)
    }
    await controller.attach({code,root:'/ignored',agentPreset:'ignored',permissionPreset:'danger-full-access',accepting:true},connection)
    await waitFor(()=>controller.snapshot().state==='connected')
    assert.deepEqual({root:controller.snapshot().root,permission:controller.snapshot().permissionPreset,accepting:controller.snapshot().accepting,preset:controller.snapshot().agentPreset},
      {root,permission:'read-only',accepting:false,preset:'local'})
    assert.equal((await stat(file)).mode&0o777,0o600)
    assert.equal(JSON.stringify(controller.snapshot()).includes(token),false)
    await controller.close();controller=createExecutorController(options);await controller.load()
    await waitFor(()=>controller.snapshot().state==='connected');assert.equal(controller.snapshot().accepting,false)
  }finally{await controller.close();await rm(directory,{recursive:true,force:true})}
})


test('delegated workers retain durable ancestry, inherit restrictions and cannot report the root Ticket',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-tree-')),file=join(directory,'executor.json'),host=native()
  let stop=false
  const command={kind:'run',ticketId:ticket,assignmentId:assignment,name:'tree',directory:'/workspace/tree',title:'Tree',instructions:'Task',allow:['read','subagent','wait_agent'],
    tools:[{name:'orchestrator_read',parameters:{},description:'Read'},{name:'orchestrator_report',parameters:{},description:'Report'}],messages:[{id:'tree-input',text:'Task'}]}
  const request=async(address:string,init:RequestInit)=>address.endsWith('/pair')?Response.json({protocol,token}):Response.json({protocol,commands:[stop?{kind:'stop',ticketId:ticket,assignmentId:assignment}:command],acknowledged:JSON.parse(String(init.body)).states.map((state:any)=>({...state})),retryAfterMs:1000})
  const controller=createExecutorController({ctx:host.ctx,file,request})
  try{
    await controller.pair({code:JSON.stringify({protocol,endpoint,pairingKey}),root:join(directory,'work'),permissionPreset:'danger-full-access'})
    await controller.configure({accepting:true,maxWorkers:1});await controller.reconnect();await waitFor(()=>host.prompts.length===1)
    const root=host.agents.get(host.prompts[0].sessionId),child=await host.child(root.id),grandchild=await host.child(child.id,'grandchild')
    assert.deepEqual(host.permissions,['danger-full-access'],'children preserve native delegated permissions')
    assert.ok(child.restrictions[0].includes('subagent'));assert.ok(!child.restrictions[0].includes('write'))
    assert.ok(child.localTools.has('orchestrator_read'));assert.ok(!child.localTools.has('orchestrator_report'))
    await assert.rejects(child.guards[0]({agent:child,name:'orchestrator_report'},()=>{}),/unavailable|Only the root/)
    await assert.rejects(child.guards[0]({agent:child,name:'write'},()=>{}),/unavailable/)
    root.status='idle';await host.emit('session/event',root.session,{type:'turn/end',data:{reason:{kind:'completed'}}})
    assert.equal(controller.snapshot().running,1,'children hold the Ticket slot after the parent turn ends')
    const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.jobs[root.id].children[grandchild.id].parentSessionId,child.id)
    host.processes.push({id:'child-process',owner:child.id,status:'running'},{id:'unrelated',owner:'other-task',status:'running'})
    const release=Promise.withResolvers<void>(),original=host.runtime.drain;let draining=false
    host.runtime.drain=async roots=>{draining=true;await release.promise;await original(roots);host.agents.delete(grandchild.id)}
    stop=true;const reconnect=controller.reconnect();await reconnect
    await waitFor(()=>draining)
    assert.notEqual(controller.snapshot().jobs[0].state,'stopped','no stop acknowledgement before native tree drain settles')
    release.resolve();await waitFor(()=>controller.snapshot().jobs[0]?.state==='stopped')
    assert.equal(host.agents.has(root.id),false);assert.equal(host.agents.has(child.id),false);assert.equal(host.agents.has(grandchild.id),false)
    assert.equal(host.processes[0].status,'stopped');assert.equal(host.processes[1].status,'running')
    await assert.rejects(child.guards[0]({agent:child,name:'read'},()=>{}),/Assignment ended/)
  }finally{await controller.close();await rm(directory,{recursive:true,force:true})}
})

test('retry resumes the same Session under a fresh native root and preserves child catalogs',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-retry-tree-')),file=join(directory,'executor.json'),host=native()
  let phase='run',attempt=assignment
  const command=()=>({kind:'run',ticketId:ticket,assignmentId:attempt,name:'retry-tree',directory:'/workspace/tree',title:'Tree',instructions:'Task',allow:['read','subagent'],tools:[],messages:[{id:attempt,text:'Task'}]})
  const request=async(address:string,init:RequestInit)=>address.endsWith('/pair')?Response.json({protocol,token}):Response.json({protocol,commands:[phase==='stop'?{kind:'stop',ticketId:ticket,assignmentId:attempt}:command()],retryAfterMs:1000})
  const controller=createExecutorController({ctx:host.ctx,file,request})
  try{
    await controller.pair({code:JSON.stringify({protocol,endpoint,pairingKey}),root:join(directory,'work')});await controller.configure({accepting:true,maxWorkers:1});await controller.reconnect()
    await waitFor(()=>host.prompts.length===1)
    const id=host.prompts[0].sessionId,old=host.agents.get(id);await host.child(id,'old-child')
    phase='stop';await controller.reconnect();await waitFor(()=>controller.snapshot().jobs[0]?.state==='stopped')
    assert.equal(host.agents.has(id),false)
    attempt='e'.repeat(32);phase='run';await controller.reconnect();await waitFor(()=>host.prompts.length===2)
    assert.equal(host.prompts[1].sessionId,id);assert.notEqual(host.agents.get(id),old)
    await host.child(id,'new-child')
    assert.deepEqual(controller.snapshot().jobs[0].children.map((child:any)=>child.id).sort(),['new-child','old-child'])
    const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.jobs[id].accepted.includes(attempt),true)
  }finally{await controller.close();await rm(directory,{recursive:true,force:true})}
})

test('unreadable descendant catalogs block reconnect without replaying child work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-bad-tree-')),file=join(directory,'executor.json'),host=native()
  await import('node:fs/promises').then(fs=>fs.writeFile(file,JSON.stringify({endpoint,token,root:directory,accepting:true,maxWorkers:1,jobs:{root:{sessionId:'root',ticketId:ticket,assignmentId:assignment,state:'running',created:true,children:{},accepted:[],read:[],requested:[],revision:1}}})))
  host.ctx.subagents.listDescendants=async()=>[{kind:'diagnostic',id:'child',parentId:'root',mode:'unknown'}]
  let networkCalls=0
  const controller=createExecutorController({ctx:host.ctx,file,request:async()=>{networkCalls++;throw new Error('No dispatch permitted')}})
  try{
    await controller.load();assert.equal(controller.snapshot().state,'configuration-error')
    await assert.rejects(controller.reconnect(),/could not be reconciled/)
    assert.equal(networkCalls,0);assert.equal(host.prompts.length,0)
  }finally{await controller.close();await rm(directory,{recursive:true,force:true})}
})

test('failed native cleanup retains the guard on a surviving delegated worker',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-failed-drain-')),host=native()
  const command={kind:'run',ticketId:ticket,assignmentId:assignment,name:'failed-drain',directory:'/workspace/tree',title:'Tree',instructions:'Task',allow:['read','subagent'],tools:[],messages:[{id:'run',text:'Task'}]}
  const request=async(address:string)=>address.endsWith('/pair')?Response.json({protocol,token}):Response.json({protocol,commands:[command],retryAfterMs:1000})
  const controller=createExecutorController({ctx:host.ctx,file:join(directory,'executor.json'),request})
  try{
    await controller.pair({code:JSON.stringify({protocol,endpoint,pairingKey}),root:join(directory,'work')});await controller.configure({accepting:true,maxWorkers:1});await controller.reconnect();await waitFor(()=>host.prompts.length===1)
    const child=await host.child(host.prompts[0].sessionId)
    host.runtime.drain=async()=>{throw new Error('Native cleanup failed')}
    await controller.close()
    assert.notEqual(controller.snapshot().jobs[0].state,'stopped')
    await assert.rejects(child.guards[0]({agent:child,name:'read'},()=>{throw new Error('Guard bypassed')}),/Assignment ended/)
  }finally{await controller.close();await rm(directory,{recursive:true,force:true})}
})
