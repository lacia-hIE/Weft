/** CI-only broker and keyless model for exercising the published, unmodified DSH Agent. */
import {z} from 'zod'
import {Store} from '../../plugins/superagent/src/app/store.ts'
import {Engine, key, type Policy, type Trigger} from '../../plugins/superagent/src/core/index.ts'
import {RemoteExecutor} from '../../plugins/superagent/src/executor/remote.ts'
import {memorySql} from './superagent-sql.ts'

export async function localExecutorFixture() {
  const sql=memorySql(),store=new Store(sql)
  let engine:Engine,deviceId='',modelCalls=0
  const remote=new RemoteExecutor({store,get engine(){return engine},changed(){},
    configuration:()=>({instructions:'LOCAL_EXECUTOR_NATIVE_TEST: Own this task. Create the requested proof file, then report ready with orchestrator_report.',allow:['read','write','bash','job_output','job_list','job_kill']}),
    tools:ticket=>[{name:'orchestrator_report',description:'Report the task result.',schema:z.object({state:z.enum(['progress','ready','failed']),summary:z.string()}),
      execute:async args=>{engine.report(ticket.id,args as {state:'ready';summary:string});return {reported:true}}}],
  })
  const policy:Policy={version:'v1',paused:false,evalTimeoutMs:60_000,gate:()=>({admissible:true,strength:'explicit',basis:{via:'listed',sender:'alice'}}),revalidate:()=>true,admitsInferred:()=>false}
  engine=new Engine({repo:store,scope:{scope:()=>({listened:true,observed:false})},policy:()=>policy,assessor:{request(){}},executor:remote,
    outbox:{send(){},withdraw(){},status:()=> 'pending'},prepareTicket:ticket=>({...ticket,execution:{name:'native-proof',directory:'/workspace/native-proof',assignment:'',executorId:deviceId}})})
  const pairing=await remote.create('Native computer');deviceId=pairing.id
  const prefix=`/v1/plugin-hooks/native/default/%40weft%2Fdsh-superagent/executor/${deviceId}`
  const taskId=key('native-executor-source')
  const event=(name:string,data:unknown)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const model=(body:{system?:unknown;messages?:unknown[];tools?:{name:string}[]})=>{
    const history=JSON.stringify(body.messages),managed=JSON.stringify(body.system).includes('LOCAL_EXECUTOR_NATIVE_TEST')
    if(managed)modelCalls++
    const write={name:'write',input:{file_path:'executor-proof.txt',content:'LOCAL_EXECUTOR_FILE_CREATED\n'}}
    const report={name:'orchestrator_report',input:{state:'ready',summary:'LOCAL_EXECUTOR_READY'}}
    const call=managed?(!history.includes('LOCAL_EXECUTOR_FILE_CREATED')?write:!history.includes('LOCAL_EXECUTOR_READY')?report:undefined):undefined
    const ptc=body.tools?.some(tool=>tool.name==='run_code')
    const invocation=call&&ptc?{name:'run_code',input:{code:`return await tools.${call.name}(${JSON.stringify(call.input)});`,description:'Complete the local executor task'}}:call
    return new Response(event('message_start',{message:{id:crypto.randomUUID(),type:'message',role:'assistant',content:[],model:'deepseek-v4-flash',usage:{input_tokens:10,output_tokens:0}}})+
      event('content_block_start',{index:0,content_block:invocation?{type:'tool_use',id:crypto.randomUUID(),name:invocation.name,input:{}}:{type:'text',text:''}})+
      event('content_block_delta',{index:0,delta:invocation?{type:'input_json_delta',partial_json:JSON.stringify(invocation.input)}:{type:'text_delta',text:'Done.'}})+
      event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:invocation?'tool_use':'end_turn'},usage:{output_tokens:5}})+event('message_stop',{}),{headers:{'content-type':'text/event-stream'}})
  }
  return {
    close:()=>sql.close(),
    matches:(path:string)=>path==='/models'||path.startsWith('/__test/executor')||path.startsWith(prefix),
    async handle(path:string,body:string,authorization:string):Promise<Response>{
      try{
        if(path==='/models')return Response.json({data:[{id:'deepseek-v4-flash',api_capabilities:{anthropic_messages:{}},context_window:128000,max_output_tokens:8192}]})
        if(path.startsWith('/__test/executor-model/'))return model(JSON.parse(body))
        if(path==='/__test/executor'){
          if(body){
            const trigger:Trigger={id:taskId,source:'chat',threads:[{source:'chat',id:'local-task'}],actor:{source:'chat',id:'alice'},human:true,addressed:'direct',at:new Date().toISOString(),text:'Create executor-proof.txt in the task directory and report the result.',meta:{}}
            engine.receive(trigger);engine.evaluateDue();engine.decide(taskId,{kind:'accept',title:'Native local execution',scope:'Create proof file',reason:'requested'})
          }
          return Response.json({pairingCode:JSON.stringify({protocol:pairing.protocol,endpoint:`https://127.0.0.1:4173${prefix}`,pairingKey:pairing.pairingKey}),modelCalls,tickets:store.tickets.list(),devices:remote.list()})
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
