import {readFile,writeFile,rename,mkdir,chmod,unlink,realpath} from 'node:fs/promises';
import {dirname,resolve,isAbsolute,relative,sep} from 'node:path';
const PROTOCOL='weft-executor/1';
const TOOL_NAMES=new Set(['orchestrator_read','orchestrator_ack','orchestrator_report','orchestrator_thread_follow','orchestrator_thread_unrelated','orchestrator_trigger_handback']);
const hex=/^[a-f0-9]{32}$/,token=/^[a-f0-9]{64}$/;
const sleep=(ms,signal)=>new Promise(resolve=>{const end=()=>{clearTimeout(timer);signal.removeEventListener('abort',end);resolve();};const timer=setTimeout(end,ms);signal.addEventListener('abort',end,{once:true});if(signal.aborted)end();});
export function executorEndpoint(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!/^\/v1\/plugin-hooks\/[^/]+\/[^/]+\/%40weft%2Fdsh-superagent\/executor\/[a-f0-9-]{36}$/i.test(url.pathname))throw new Error('Invalid Executor endpoint');
  return url.href;
}
async function privateWrite(file,value){
  await mkdir(dirname(file),{recursive:true,mode:0o700});const temporary=`${file}.${crypto.randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,file);}
  finally{await unlink(temporary).catch(()=>{});}
}

/** One native DSH, one persisted mailbox; reconnects do not replay accepted prompts. */
export function createExecutorController({ctx,file,request=fetch}){
  let data={accepting:false,maxWorkers:1,jobs:{}},status='unpaired',closed=false,loop,stop;
  let saving=Promise.resolve(),actions=Promise.resolve();const disposers=[],configured=new WeakSet();
  const save=()=>{const copy=JSON.parse(JSON.stringify(data));return saving=saving.catch(()=>{}).then(()=>privateWrite(file,copy));};
  const serial=run=>{const result=actions.then(run);actions=result.catch(()=>{});return result;};
  const jobOf=agent=>data.jobs[agent?.id];
  const activeJobs=()=>Object.values(data.jobs).filter(job=>job.state==='running');
  const change=(job,fields)=>{Object.assign(job,fields);job.revision++;return save();};
  async function post(operation,body,signal){
    const response=await request(data.endpoint+'/'+operation,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${data.token??data.pairingKey}`},
      body:JSON.stringify(body),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(40_000)])});
    const value=await response.json();
    if(!response.ok){const error=new Error(value.error??`Executor HTTP ${response.status}`);error.status=response.status;throw error;}
    return value;
  }
  function attach(agent){
    const job=jobOf(agent);if(!job||configured.has(agent))return;configured.add(agent);
    disposers.push(agent.ctx.systemPrompt.section({name:'weft-executor',order:600,interpolate:false,text:()=>jobOf(agent)?.instructions??''}));
    const names=[...agent.ctx.tools.view(agent).restrictableNames];
    // Agent subdelegation is disabled until its durable lifecycle is tracked by this carrier.
    const allow=names.filter(name=>!['subagent','send_message','list_agents','interrupt_agent','list_subagent_models'].includes(name)&&job.allow.some(pattern=>pattern.endsWith('*')?name.startsWith(pattern.slice(0,-1)):name===pattern));
    disposers.push(agent.ctx.tools.restrict({allow}));
    disposers.push(agent.ctx.on('tools/execute',async(execution,next)=>{
      const current=jobOf(agent);
      if(!current||current.state==='stopped'||current.stopping)throw new Error('Assignment ended');
      if(execution.name!=='run_code'&&!TOOL_NAMES.has(execution.name)&&(!allow.includes(execution.name)
        && !current.allow.some(pattern=>pattern.endsWith('*')?execution.name.startsWith(pattern.slice(0,-1)):execution.name===pattern)
        || ['subagent','send_message','list_agents','interrupt_agent','list_subagent_models'].includes(execution.name)))throw new Error('Tool is unavailable to this Executor');
      return next();
    }));
    for(const tool of job.tools){
      if(!TOOL_NAMES.has(tool.name))throw new Error('Unrecognized Executor tool');
      disposers.push(agent.ctx.tools.register({...tool,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
        execute:async(args,execution)=>{
          const current=jobOf(agent);
          if(!current||current.state==='stopped')throw new Error('Assignment ended');
          const payload={ticketId:current.ticketId,assignmentId:current.assignmentId,requestId:String(execution.callId),name:tool.name,args};
          // Identical tool retries use the native call ID; cloud receipts prevent duplicate reports and replies.
          const result=await post('tool',payload,execution.signal);
          if(tool.name==='orchestrator_report'){
            await change(current,{handoff:args.state!=='progress'||!!args.human_action});
          }
          return result;
        }}));
    }
  }
  disposers.push(ctx.on('agent/created',({agent})=>attach(agent)));
  disposers.push(ctx.on('session/event',(session,event)=>{
    const job=data.jobs[session.id];if(!job||job.state==='stopped')return;
    if(event.type==='user/message'){
      const requestId=event.data?.source?.rpcId;
      if(job.requested?.includes(requestId)&&!job.read.includes(requestId)){job.read.push(requestId);void change(job,{});}
    }
    if(event.type==='turn/start')void change(job,{state:'running'});
    if(event.type==='assistant/message'){
      const text=event.data?.message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n');if(text)job.summary=text.slice(-12000);
    }
    if(event.type==='turn/end'){
      const failed=event.data?.reason?.kind==='error';
      const background=ctx.jobs?.list(session.id).some(item=>item.owner===session.id&&['running','stopping'].includes(item.status));
      void change(job,{state:failed?'failed':background&&!job.handoff?'running':'waiting',...(failed?{error:event.data.reason.error?.message??'Agent turn failed'}:{})});
    }
  }));
  async function cancel(job){
    job.stopping=true;await save();
    const agent=ctx.agents.get(job.sessionId);
    // SessionController.cancel intentionally retains queued messages. Assignment shutdown must drop that inbox.
    if(agent?.cancel)agent.cancel({kind:'user'},{keepInbox:false});
    else if(agent)await ctx.sessionController.cancel({sessionId:job.sessionId});
    for(const item of ctx.jobs?.list(job.sessionId)??[])if(item.owner===job.sessionId&&['running','stopping'].includes(item.status)){
      ctx.jobs.kill(item.id,job.sessionId,'Assignment ended');
      const settled=await ctx.jobs.wait(item.id,10_000,job.sessionId);
      if(['running','stopping'].includes(settled.status))throw new Error('Background process has not stopped; cancellation will be retried');
    }
    const deadline=Date.now()+10_000,signal=AbortSignal.timeout(10_000);
    while(agent?.status==='running'&&Date.now()<deadline)await sleep(25,signal);
    if(agent?.status==='running')throw new Error('Agent has not stopped; cancellation will be retried');
    await change(job,{state:'stopped'});
  }
  async function accept(command){
    if(!hex.test(command.ticketId)||!hex.test(command.assignmentId))throw new Error('Invalid Assignment identity');
    const sessionId=`weft-${new URL(data.endpoint).pathname.split('/').at(-1)}-${command.ticketId}`;
    let job=data.jobs[sessionId];
    if(command.kind==='stop'){
      if(job&&job.assignmentId===command.assignmentId&&job.state!=='stopped')await cancel(job);
      else if(!job){data.jobs[sessionId]={ticketId:command.ticketId,assignmentId:command.assignmentId,sessionId,cwd:'',revision:0,state:'stopped',accepted:[],requested:[],read:[],tools:[],allow:[],instructions:'',created:false};await save();}
      return;
    }
    if(command.kind!=='run'||!data.accepting)return;
    if(typeof command.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,120}$/.test(command.name)||typeof command.instructions!=='string'||command.instructions.length>256*1024
      ||!Array.isArray(command.tools)||command.tools.length>10||!Array.isArray(command.allow)||command.allow.some(name=>typeof name!=='string')
      ||!Array.isArray(command.messages)||command.messages.length>200)throw new Error('Invalid Assignment');
    if(job?.assignmentId!==command.assignmentId&&job&&job.state!=='stopped')await cancel(job);
    if(!job||job.assignmentId!==command.assignmentId){
      if(activeJobs().length>=data.maxWorkers)return;
      const cwd=resolve(data.root,command.name);
      await mkdir(cwd,{recursive:true});
      const canonical=await realpath(cwd),inside=relative(data.root,canonical);
      if(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw new Error('Task directory escapes the execution root');
      job={ticketId:command.ticketId,assignmentId:command.assignmentId,sessionId,cwd:canonical,revision:0,state:'waiting',accepted:[],requested:[],read:[],tools:command.tools,allow:command.allow,
        instructions:command.instructions.split(command.directory).join(canonical),created:data.jobs[sessionId]?.created??false,handoff:false};
      data.jobs[sessionId]=job;await save();
    }
    job.instructions=command.instructions.split(command.directory).join(job.cwd);
    await save();
    // A retry uses the existing non-blank Session; only first creation calls create.
    if(!job.created){
      const created=await ctx.sessionController.create({sessionId,cwd:job.cwd,...data.agentPreset?{agentPreset:data.agentPreset}:{}});
      if(created.sessionId!==sessionId)throw new Error('Session identity is already owned by other work');
      await change(job,{created:true});
      await ctx.sessionController.rename({sessionId,title:command.title});
    }
    const live=ctx.agents.get(sessionId);if(live)attach(live);
    for(const message of command.messages){
      if(typeof message.id!=='string'||typeof message.text!=='string'||message.text.length>256*1024)throw new Error('Invalid task input');
      if(job.accepted.includes(message.id))continue;
      if(job.state!=='running'&&activeJobs().length>=data.maxWorkers)return;
      if(!job.requested.includes(message.id))job.requested.push(message.id);
      await change(job,{state:'running',handoff:false});
      // The native inbox deduplicates requestId, including a crash before accepted is saved.
      await ctx.sessionController.prompt({sessionId,requestId:message.id,mode:'steer',content:[{type:'text',text:message.text.split(command.directory).join(job.cwd)}]});
      if(!job.accepted.includes(message.id))job.accepted.push(message.id);
      await change(job,{});
    }
  }
  async function run(signal){
    while(!signal.aborted){
      let delay=15_000;
      try{
        if(!data.token){
          status='connecting';const paired=await post('pair',{},signal);
          if(paired.protocol!==PROTOCOL||!token.test(paired.token))throw new Error('Invalid Executor pairing response');
          data.token=paired.token;delete data.pairingKey;await save();
        }
        await saving;
        const states=Object.values(data.jobs).filter(job=>job.revision>(job.syncedRevision??-1)).slice(0,100)
          .map(({ticketId,assignmentId,sessionId,revision,state,accepted,read,error,summary})=>({ticketId,assignmentId,sessionId,revision,state,accepted:accepted.slice(-200),read:read.slice(-200),...error?{error}:{},...summary?{summary}:{}}));
        const reply=await post('sync',{protocol:PROTOCOL,accepting:data.accepting,states},signal);
        if(reply.protocol!==PROTOCOL||!Array.isArray(reply.commands))throw new Error('Invalid Executor response');
        for(const ack of reply.acknowledged??[]){const job=Object.values(data.jobs).find(job=>job.ticketId===ack.ticketId&&job.assignmentId===ack.assignmentId);if(job)job.syncedRevision=ack.revision;}
        await save();
        status='connected';
        for(const command of reply.commands){
          try{await accept(command);}
          catch(error){
            const sessionId=`weft-${new URL(data.endpoint).pathname.split('/').at(-1)}-${command.ticketId}`;
            let job=data.jobs[sessionId];
            if(!job&&hex.test(command.ticketId)&&hex.test(command.assignmentId)){
              job={ticketId:command.ticketId,assignmentId:command.assignmentId,sessionId,cwd:'',revision:0,state:'failed',accepted:[],requested:[],read:[],tools:[],allow:[],instructions:'',created:false};data.jobs[sessionId]=job;
            }
            if(job)await change(job,{state:'failed',error:String(error).slice(0,4000)});else throw error;
          }
        }
        delay=reply.commands.length?1000:Math.max(1000,Math.min(30_000,reply.retryAfterMs??15_000));
      }catch(error){
        if(signal.aborted)break;
        if(error.status===401||error.status===403){status='revoked';return;}
        status='retrying';
      }
      await sleep(delay,signal);
    }
  }
  const start=()=>{if(closed||!data.endpoint||stop)return;stop=new AbortController();loop=run(stop.signal);};
  const disconnect=async()=>{stop?.abort();await loop;stop=undefined;status='stopped';};
  return {
    snapshot:()=>({state:status,configured:!!data.endpoint,endpoint:data.endpoint,accepting:data.accepting,root:data.root??'',maxWorkers:data.maxWorkers,agentPreset:data.agentPreset??'',
      running:activeJobs().length,jobs:Object.values(data.jobs).map(({ticketId,sessionId,state,cwd})=>({ticketId,sessionId,state,cwd}))}),
    load:()=>serial(async()=>{
      try{
        data=JSON.parse(await readFile(file,'utf8'));executorEndpoint(data.endpoint);
        if(!token.test(data.token??data.pairingKey??'')||!isAbsolute(data.root)||!Number.isInteger(data.maxWorkers)||data.maxWorkers<1||data.maxWorkers>16||typeof data.accepting!=='boolean')throw new Error('Invalid Executor configuration');
        for(const job of Object.values(data.jobs)){
          const live=ctx.agents.get(job.sessionId);if(live)attach(live);
          else if(job.state==='running')await change(job,{state:'failed',error:'Local DSH restarted during execution. Retry this Ticket to resume its retained Session and files.'});
        }
        start();
      }catch(error){if(error.code!=='ENOENT')status='configuration-error';}
    }),
    pair:input=>serial(async()=>{
      if(Object.values(data.jobs).some(job=>job.state!=='stopped'))throw new Error('Stop or finish existing Assignments before pairing another executor');
      const code=JSON.parse(input.code.trim().startsWith('{')?input.code:Buffer.from(input.code.trim(),'base64url').toString());
      if(code.protocol!==PROTOCOL||!token.test(code.pairingKey??''))throw new Error('Invalid Executor pairing code');
      const endpoint=executorEndpoint(code.endpoint);
      if(!isAbsolute(input.root))throw new Error('Choose an absolute execution directory');
      await mkdir(input.root,{recursive:true});const root=await realpath(input.root);
      await disconnect();data={endpoint,pairingKey:code.pairingKey,root,accepting:false,maxWorkers:1,jobs:{},agentPreset:input.agentPreset?.trim()??''};
      await save();start();
    }),
    configure:input=>serial(async()=>{
      if(!data.endpoint)throw new Error('Pair this computer first');
      if(typeof input.accepting!=='boolean'||!Number.isInteger(input.maxWorkers)||input.maxWorkers<1||input.maxWorkers>16)throw new Error('Invalid execution settings');
      data.accepting=input.accepting;data.maxWorkers=input.maxWorkers;await save();
    }),
    reconnect:()=>serial(async()=>{await disconnect();start();}),
    disconnect:()=>serial(disconnect),
    close:()=>serial(async()=>{
      closed=true;await disconnect();
      for(const job of Object.values(data.jobs))if(job.state!=='stopped'){
        try{await cancel(job);}catch{/* Preserve failure, rather than claiming cancellation succeeded. */}
        await change(job,{state:'failed',error:'Local Executor stopped. Retry the Ticket to resume its retained Session and files.'});
      }
      for(const dispose of disposers.reverse())if(typeof dispose==='function')dispose();await saving;
    }),
  };
}
