import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
// @ts-expect-error Native published plugin is JavaScript.
import {createExecutorController, executorEndpoint} from '../packages/local-host-connector/executor.mjs'

const protocol='weft-executor/1',device=crypto.randomUUID(),ticket='a'.repeat(32),assignment='b'.repeat(32)
const endpoint=`https://weft.example/v1/plugin-hooks/tenant/default/%40weft%2Fdsh-superagent/executor/${device}`
const pairingKey='c'.repeat(64),token='d'.repeat(64)
const waitFor=async(check:()=>boolean)=>{for(let end=Date.now()+5000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,20)))if(check())return;throw new Error('Executor did not settle')}
function native() {
  const listeners=new Map<string, Set<(...args: any[])=>unknown>>(),agents=new Map<string, any>(),prompts: any[]=[],cancelled: string[]=[],tools=new Map<string, any>()
  const on=(event: string, callback:(...args: any[])=>unknown)=>{const set=listeners.get(event)??new Set();set.add(callback);listeners.set(event,set);return()=>set.delete(callback)}
  const emit=async(event: string,...args: any[])=>{for(const callback of listeners.get(event)??[])await callback(...args)}
  const ctx={on,agents:{get:(id: string)=>agents.get(id)},jobs:{list:()=>[]},sessionController:{
    create:async({sessionId}: {sessionId: string})=>{
      const agent={id:sessionId,ctx:{on:()=>()=>{},systemPrompt:{section:()=>()=>{}},tools:{view:()=>({restrictableNames:new Set(['read','subagent'])}),restrict:({allow}:{allow:string[]})=>{assert.deepEqual(allow,['read']);return()=>{}},register:(tool: any)=>{tools.set(tool.name,tool);return()=>{tools.delete(tool.name)}}}}}
      agents.set(sessionId,agent);await emit('agent/created',{agent});return {sessionId}
    },
    rename:async()=>{},
    prompt:async(input: any,signal:AbortSignal)=>{signal.throwIfAborted();prompts.push(input);await emit('session/event',{id:input.sessionId},{type:'user/message',data:{source:{rpcId:input.requestId}}});await emit('session/event',{id:input.sessionId},{type:'turn/start'})},
    cancel:async({sessionId}:{sessionId:string})=>{cancelled.push(sessionId)},
  }}
  return {ctx,prompts,cancelled,tools,emit}
}

test('local Executor opts in separately, retains native prompt identities, and confirms cancellation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-executor-')),file=join(directory,'executor.json'),root=join(directory,'work'),host=native()
  const command={kind:'run',ticketId:ticket,assignmentId:assignment,name:'fix-example',directory:'/workspace/example',title:'Fix example',instructions:'Work in /workspace/example.',allow:['read','subagent'],
    tools:[{name:'orchestrator_report',description:'Report',parameters:{}}],messages:[{id:'first-input',text:'The original request.',inputs:[]}]}
  let stop=false,syncs=0
  const request=async(address: string,init: RequestInit)=>{
    assert.equal(init.redirect,'error')
    if(address.endsWith('/pair'))return Response.json({protocol,token})
    assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${token}`)
    const body=JSON.parse(String(init.body))
    if(address.endsWith('/tool'))return Response.json({reported:true})
    syncs++
    return Response.json({protocol,commands:[stop?{kind:'stop',ticketId:ticket,assignmentId:assignment}:command],retryAfterMs:1000,
      acknowledged:body.states.map(({ticketId,assignmentId,revision}: any)=>({ticketId,assignmentId,revision}))})
  }
  let controller=createExecutorController({ctx:host.ctx,file,request})
  try {
    await controller.load();assert.equal(controller.snapshot().configured,false)
    await controller.pair({code:JSON.stringify({protocol,endpoint,pairingKey}),root})
    await waitFor(()=>syncs>0)
    assert.equal(host.prompts.length,0,'pairing never opts the device into execution')
    assert.equal(controller.snapshot().accepting,false)
    await controller.configure({accepting:true,maxWorkers:1});await controller.reconnect()
    await waitFor(()=>host.prompts.length===1)
    assert.equal(host.prompts[0].requestId,'first-input')
    await controller.reconnect();await waitFor(()=>syncs>=3)
    assert.equal(host.prompts.length,1,'redelivered commands never repeat accepted prompts')
    assert.equal(host.tools.has('orchestrator_report'),true)
    const sessionId=host.prompts[0].sessionId
    await host.tools.get('orchestrator_report').execute({state:'progress'},{callId:'tool-1',signal:new AbortController().signal})
    assert.equal((await stat(file)).mode&0o777,0o600)
    assert.equal(JSON.stringify(controller.snapshot()).includes(token),false)
    assert.equal(JSON.parse(await readFile(file,'utf8')).token,token)
    await controller.close();controller=createExecutorController({ctx:host.ctx,file,request});await controller.load()
    await waitFor(()=>controller.snapshot().state==='connected')
    assert.equal(host.prompts.length,1,'a connector restart preserves the native inbox receipts')
    stop=true;await controller.reconnect()
    await waitFor(()=>controller.snapshot().jobs[0]?.state==='stopped')
    assert.deepEqual(host.cancelled,[sessionId,sessionId])
  } finally {await controller.close();await rm(directory,{recursive:true,force:true})}
})

test('Executor pairing rejects unrelated, plaintext and credential-bearing endpoints',()=>{
  assert.equal(executorEndpoint(endpoint),endpoint)
  for(const target of [endpoint.replace('https:','http:'),endpoint+'?token=secret',endpoint.replace('weft.example','user:pass@weft.example'),'https://weft.example/v1/local-hosts/t/e'])assert.throws(()=>executorEndpoint(target))
})
