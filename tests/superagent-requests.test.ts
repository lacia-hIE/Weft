import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Engine, latestAssignment} from '../plugins/superagent/src/core/index.ts'
import {Store} from '../plugins/superagent/src/app/store.ts'
import {appendRequest, submitRequest} from '../plugins/superagent/src/app/requests.ts'
import {HybridExecutor} from '../plugins/superagent/src/executor/hybrid.ts'
import {RemoteExecutor, EXECUTOR_PROTOCOL} from '../plugins/superagent/src/executor/remote.ts'
import {SourceRegistry} from '../plugins/superagent/src/sources/registry.ts'
import {requestKind} from '../plugins/superagent/src/sources/request.ts'
import {settingsPolicy} from '../plugins/superagent/src/policy.ts'
import {mainTools} from '../plugins/superagent/src/app/tools/main.ts'
import {memorySql} from './helpers/superagent-sql.ts'

test('owner requests pass Eval without GitHub, retain placement and project, and accept follow-ups idempotently', async () => {
  const sql=memorySql(), store=new Store(sql), sources=new SourceRegistry(()=>store.settings())
  sources.register(requestKind)
  let engine:Engine
  const remote=new RemoteExecutor({store,get engine(){return engine},changed(){},configuration:()=>({instructions:'Task',allow:['read']}),tools:()=>[]})
  const executor=new HybridExecutor({store,effects:{handle(){},enqueue(){}},paused:()=>false} as never,remote)
  engine=new Engine({repo:store,scope:sources,policy:()=>settingsPolicy(store.settings(),sources),assessor:{request(){}},executor,
    outbox:{send(){},withdraw(){},status:()=> 'sent'},prepareTicket:(ticket,outcome)=>executor.prepare(ticket,outcome)})
  const receive=(trigger:Parameters<Engine['receive']>[0])=>engine.receive(trigger)
  const host={store,remote,receive}
  try {
    const computer=await remote.create('Internal workstation'), second=await remote.create('Another computer')
    await remote.pair(computer.id,computer.pairingKey);await remote.pair(second.id,second.pairingKey)
    remote.sync(computer.id,{protocol:EXECUTOR_PROTOCOL,accepting:false,states:[],projects:[{id:'intranet',name:'Internal repository'}]})
    const request={requestId:crypto.randomUUID(),text:'Implement and verify the requested fix in the internal project.',executorId:computer.id,projectId:'intranet'}
    assert.throws(()=>submitRequest(host,{...request,actor:{id:'someone'}}),/Unrecognized/)
    assert.throws(()=>submitRequest(host,{...request,projectId:'unknown'}),/unavailable/)
    const received=submitRequest(host,request)
    assert.equal(received.result,'stored');assert.equal(store.tickets.list().length,0,'only Eval can create a Ticket')
    assert.equal(submitRequest(host,request).result,'duplicate')
    assert.throws(()=>submitRequest(host,{...request,text:'Changed'}),/different contents/)
    engine.evaluateDue()
    assert.equal(engine.candidate(received.triggerId)?.strength,'explicit')
    // A later default change cannot retarget an already submitted request.
    store.saveSettings({...store.settings(),executor:{...store.settings().executor,executorId:second.id}})
    const decision=engine.decide(received.triggerId,{kind:'accept',title:'Internal fix',scope:'Requested fix',reason:'User requested it',name:'internal-fix'})
    const ticket=store.tickets.get(decision.ticketId!)!
    assert.equal(ticket.execution?.executorId,computer.id);assert.equal(ticket.execution?.projectId,'intranet')
    const paused=remote.sync(computer.id,{protocol:EXECUTOR_PROTOCOL,accepting:false,states:[]})
    assert.equal(paused.commands.length,0)
    assert.equal(remote.sync(second.id,{protocol:EXECUTOR_PROTOCOL,accepting:true,states:[]}).commands.length,0)
    const dispatched=remote.sync(computer.id,{protocol:EXECUTOR_PROTOCOL,accepting:true,states:[]}).commands as {projectId:string;assignmentId:string}[]
    assert.equal(dispatched.length,1);assert.equal(dispatched[0]!.projectId,'intranet')
    assert.equal(dispatched[0]!.assignmentId,latestAssignment(ticket)!.id)
    const follow={requestId:crypto.randomUUID(),text:'Also verify the regression case.'}
    const added=appendRequest(host,request.requestId,follow)
    assert.equal(added.thread,received.thread);assert.equal(store.tickets.get(ticket.id)!.inputs.some(input=>input.kind==='trigger'&&input.triggerId===added.triggerId),true)
    assert.equal(appendRequest(host,request.requestId,follow).result,'duplicate')
    assert.throws(()=>appendRequest(host,crypto.randomUUID(),follow),/not found/)
    const cloud=submitRequest(host,{requestId:crypto.randomUUID(),text:'Do this in the cloud.',executorId:null,projectId:null})
    engine.evaluateDue()
    const cloudDecision=engine.decide(cloud.triggerId,{kind:'accept',title:'Cloud task',scope:'Cloud task',reason:'Requested',name:'cloud-task'})
    assert.equal(store.tickets.get(cloudDecision.ticketId!)!.execution?.executorId,undefined,'an explicit cloud selection overrides the saved local default')
    const other=submitRequest(host,{requestId:crypto.randomUUID(),text:'A distinct cloud request',executorId:null,projectId:null})
    engine.evaluateDue()
    const tools=mainTools({store,engine,executors:remote,quietly:(run:()=>unknown)=>run(),requestPass(){},logger:console} as never,{id:'main'})
    const route=tools.find(tool=>tool.name==='orchestrator_route')!
    const result=await route.execute({decisions:[{kind:'attach',trigger_id:other.triggerId,ticket_id:ticket.id}]} as never,new AbortController().signal) as {results:{refused:string}[]}
    assert.match(result.results[0]!.refused,/different execution/)
    const automatic=submitRequest(host,{requestId:crypto.randomUUID(),text:'Use the internal computer.',executorId:null,placement:'auto'})
    engine.evaluateDue()
    const routeInput={kind:'accept',trigger_id:automatic.triggerId,title:'Automatic placement',worktree_name:'automatic-placement',acknowledgement:'I will verify it locally.'}
    const absent=await route.execute({decisions:[routeInput]} as never,new AbortController().signal) as {results:{refused:string}[]}
    assert.match(absent.results[0]!.refused,/Choose executor_id/)
    remote.sync(computer.id,{protocol:EXECUTOR_PROTOCOL,accepting:false,states:[]})
    const placed=await route.execute({decisions:[{...routeInput,executor_id:computer.id}]} as never,new AbortController().signal) as {results:{ticket:{ticket_id:string}}[]}
    assert.equal(store.tickets.get(placed.results[0]!.ticket.ticket_id)!.execution?.executorId,computer.id)
    assert.equal(remote.sync(computer.id,{protocol:EXECUTOR_PROTOCOL,accepting:false,states:[]}).commands.length,0,'automatic placement retains work on a paused computer')
    assert.throws(()=>submitRequest(host,{requestId:crypto.randomUUID(),text:'Wrong target',executorId:computer.id,placement:'auto'}),/cannot carry a fixed/)
    store.saveSettings({...store.settings(),sources:{request:{enabled:false,config:{}}}})
    assert.throws(()=>submitRequest(host,{...request,requestId:crypto.randomUUID()}),/disabled/)
  } finally {sql.close()}
})
