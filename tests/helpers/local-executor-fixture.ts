/** CI-only broker and keyless model for exercising the published, unmodified DSH Agent. */
import {z} from 'zod'
import {Store} from '../../plugins/superagent/src/app/store.ts'
import {Engine, key, type Policy, type Trigger} from '../../plugins/superagent/src/core/index.ts'
import {RemoteExecutor} from '../../plugins/superagent/src/executor/remote.ts'
import {memorySql} from './superagent-sql.ts'

export async function localExecutorFixture(tenant='native') {
  const sql=memorySql(),store=new Store(sql)
  let engine:Engine,deviceId='',modelCalls=0,sequence=0,currentTicketId='',released=false,retrying=false
  const pending:(()=>void)[]=[]
  const remote=new RemoteExecutor({store,get engine(){return engine},changed(){},
    configuration:()=>({instructions:'LOCAL_EXECUTOR_NATIVE_TEST: Own this task. Create the requested proof file, then report ready with orchestrator_report.',allow:['read','write','bash','job_output','job_list','job_kill','subagent','subagent_fork','send_message','list_agents','interrupt_agent','wait_agent']}),
    tools:ticket=>[{name:'orchestrator_report',description:'Report the task result.',schema:z.object({state:z.enum(['progress','ready','failed']),summary:z.string()}),
      execute:async args=>{engine.report(ticket.id,args as {state:'ready';summary:string});return {reported:true}}}],
  })
  const policy:Policy={version:'v1',paused:false,evalTimeoutMs:60_000,gate:()=>({admissible:true,strength:'explicit',basis:{via:'listed',sender:'alice'}}),revalidate:()=>true,admitsInferred:()=>false}
  engine=new Engine({repo:store,scope:{scope:()=>({listened:true,observed:false})},policy:()=>policy,assessor:{request(){}},executor:remote,
    outbox:{send(){},withdraw(){},status:()=> 'pending'},prepareTicket:ticket=>({...ticket,execution:{name:sequence===1?'native-proof':`native-tree-${sequence}`,directory:'/workspace/native-proof',assignment:'',executorId:deviceId,...(remote.list().find(device=>device.id===deviceId)?.projects[0]?.id ? {projectId:remote.list().find(device=>device.id===deviceId)!.projects[0]!.id} : {})}})})
  const pairing=await remote.create('Native computer');deviceId=pairing.id
  const prefix=`/v1/plugin-hooks/${tenant}/default/%40weft%2Fdsh-superagent/executor/${deviceId}`
  const event=(type:string,data:object)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`
  const model=async(body:{system?:unknown;messages?:unknown[];tools?:{name:string}[]})=>{
    const history=JSON.stringify(body.messages),managed=JSON.stringify(body.system).includes('LOCAL_EXECUTOR_NATIVE_TEST')
    if(managed)modelCalls++
    const userHistory=JSON.stringify(body.messages?.filter((row:any)=>row.role==='user'))
    const child=userHistory.includes('EXECUTOR_CHILD_TASK')||userHistory.includes('EXECUTOR_CANCEL_CHILD')||userHistory.includes('EXECUTOR_RETRY_CHILD_TASK')
    const cancelChild=child&&userHistory.includes('EXECUTOR_CANCEL_CHILD')
    if(cancelChild&&history.includes('EXECUTOR_BACKGROUND_STARTED')&&!released)await new Promise<void>(resolve=>pending.push(resolve))
    const write={name:'write',input:{file_path:'executor-proof.txt',content:'LOCAL_EXECUTOR_FILE_CREATED\n'}}
    const report={name:'orchestrator_report',input:{state:'ready',summary:'LOCAL_EXECUTOR_READY'}}
    const retryTask=retrying&&history.includes('EXECUTOR_RESTART_ROOT')
    const marker=retryTask?'EXECUTOR_RETRY_CHILD_TASK':history.includes('EXECUTOR_CANCEL_ROOT')||history.includes('EXECUTOR_RESTART_ROOT')?'EXECUTOR_CANCEL_CHILD':'EXECUTOR_CHILD_TASK'
    const delegate={name:marker==='EXECUTOR_CHILD_TASK'?'subagent_fork':'subagent',input:{description:'Local delegated proof',prompt:marker}}
    const background={name:'bash',input:{command:'printf EXECUTOR_BACKGROUND_STARTED; sleep 300',description:'Run a cancellable delegated background process',run_in_background:true}}
    const call=managed?(child?(cancelChild&&!history.includes('EXECUTOR_BACKGROUND_STARTED')?background:!history.includes('LOCAL_EXECUTOR_FILE_CREATED')?write:undefined):!history.includes(marker)?delegate:history.includes('DELEGATED_WORK_DONE')?(!history.includes('LOCAL_EXECUTOR_READY')?report:undefined):undefined):undefined
    const text=child?'DELEGATED_WORK_DONE':'Waiting for the delegated worker.'
    const ptc=body.tools?.some(tool=>tool.name==='run_code')
    const invocation=call&&ptc?{name:'run_code',input:{code:`return await tools.${call.name}(${JSON.stringify(call.input)});`,description:'Complete the local executor task'}}:call
    return new Response(event('message_start',{message:{id:crypto.randomUUID(),type:'message',role:'assistant',content:[],model:'deepseek-v4-flash',usage:{input_tokens:10,output_tokens:0}}})+
      event('content_block_start',{index:0,content_block:invocation?{type:'tool_use',id:crypto.randomUUID(),name:invocation.name,input:{}}:{type:'text',text:''}})+
      event('content_block_delta',{index:0,delta:invocation?{type:'input_json_delta',partial_json:JSON.stringify(invocation.input)}:{type:'text_delta',text:managed?text:'Done.'}})+
      event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:invocation?'tool_use':'end_turn'},usage:{output_tokens:5}})+event('message_stop',{}),{headers:{'content-type':'text/event-stream'}})
  }
  return {
    close:()=>{for(const resolve of pending.splice(0))resolve();sql.close()},
    matches:(path:string)=>path==='/models'||path.startsWith('/__test/executor')||path.startsWith(prefix),
    async handle(path:string,body:string,authorization:string):Promise<Response>{
      try{
        if(path==='/models')return Response.json({data:[{id:'deepseek-v4-flash',api_capabilities:{anthropic_messages:{}},context_window:128000,max_output_tokens:8192}]})
        if(path.startsWith('/__test/executor-model/'))return model(JSON.parse(body))
        if(path==='/__test/executor'){
          const input=body?JSON.parse(body):{}
          if(input.release){released=true;for(const resolve of pending.splice(0))resolve()}
          if(input.stop)engine.stopTicket(input.stop)
          if(input.retry){retrying=true;engine.retryTicket(input.retry)}
          if(input.start){
            sequence++;released=false;retrying=false
            const taskId=key(`native-executor-source-${sequence}`)
            const trigger:Trigger={id:taskId,source:'chat',threads:[{source:'chat',id:`local-task-${sequence}`}],actor:{source:'chat',id:'alice'},human:true,addressed:'direct',at:new Date().toISOString(),text:input.scenario==='cancel'?'EXECUTOR_CANCEL_ROOT':input.scenario==='restart'?'EXECUTOR_RESTART_ROOT':'Create executor-proof.txt in the task directory and report the result.',meta:{}}
            engine.receive(trigger);engine.evaluateDue();engine.decide(taskId,{kind:'accept',title:'Native local execution',scope:'Create proof file',reason:'requested'})
            currentTicketId=store.tickets.list().find(ticket=>ticket.origin.triggerId===taskId)!.id
          }
          return Response.json({pairingCode:JSON.stringify({protocol:pairing.protocol,endpoint:`https://127.0.0.1:4173${prefix}`,pairingKey:pairing.pairingKey}),modelCalls,currentTicketId,tickets:store.tickets.list(),devices:remote.list()})
        }
        const operation=path.slice(prefix.length+1),token=authorization.replace(/^Bearer /,'')
        if(operation==='pair')return Response.json(await remote.pair(deviceId,token))
        await remote.authenticate(deviceId,token)
        if(operation==='sync')return Response.json(remote.sync(deviceId,JSON.parse(body)))
        if(operation==='tool')return Response.json(await remote.call(deviceId,JSON.parse(body),new AbortController().signal))
        return Response.json({error:'Not found'},{status:404})
      }catch(error){return Response.json({error:String(error)},{status:400})}
    },
  }
}
