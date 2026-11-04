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
export function createExecutorController({ctx,agentOwner=ctx,file,request=fetch}){
  let data={accepting:false,maxWorkers:1,jobs:{}},status='unpaired',closed=false,reconciled=true,loop,stop;
  let saving=Promise.resolve(),actions=Promise.resolve();const disposers=[],configured=new WeakSet(),handles=new Map();
  const save=()=>{const copy=JSON.parse(JSON.stringify(data));return saving=saving.catch(()=>{}).then(()=>privateWrite(file,copy));};
  const serial=run=>{const result=actions.then(run);actions=result.catch(()=>{});return result;};
  const jobOf=agent=>{
    if(!agent)return;
    const direct=data.jobs[agent.id];if(direct)return direct;
    return Object.values(data.jobs).find(job=>job.children?.[agent.id]);
  };
  const belongs=id=>data.jobs[id]??Object.values(data.jobs).find(job=>job.children?.[id]);
  const members=job=>[job.sessionId,...Object.keys(job.children??{})];
  const background=job=>members(job).some(id=>ctx.jobs.list(id).some(item=>item.owner===id&&['running','stopping'].includes(item.status)));
  const busy=job=>Object.values(job.children??{}).some(child=>child.active)||background(job);
  const settle=job=>{
    if(job.stopping||job.state==='stopped'||job.state==='failed')return;
    const root=ctx.agents.get(job.sessionId);
    if(root?.status==='running'||root?.inbox?.nextTurn.length||root?.inbox?.nextStep.length||busy(job))return;
    void change(job,{state:'waiting'});
  };
  const activeJobs=()=>Object.values(data.jobs).filter(job=>job.state==='running'||job.stopping&&(ctx.agents.get(job.sessionId)?.status==='running'||busy(job)));
  const change=(job,fields)=>{Object.assign(job,fields);job.revision++;return save();};
  async function post(operation,body,signal){
    const response=await request(data.endpoint+'/'+operation,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${data.token??data.pairingKey}`},
      body:JSON.stringify(body),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(40_000)])});
    const value=await response.json();
    if(!response.ok){const error=new Error(value.error??`Executor HTTP ${response.status}`);error.status=response.status;throw error;}
    return value;
  }
  function attach(agent){
    let job=jobOf(agent);
    const parent=agent.session.header?.parentSession;
    if(!job&&parent){
      job=belongs(parent);
      if(job){
        if(job.stopping||job.state==='stopped')throw new Error('Assignment ended');
        job.children??={};job.children[agent.id]={id:agent.id,parentSessionId:parent,active:true,local:true};
        return save().then(()=>attach(agent));
      }
    }
    if(!job||configured.has(agent))return;
    if(job.stopping||job.state==='stopped')throw new Error('Assignment ended');
    configured.add(agent);
    const root=agent.id===job.sessionId,assignmentId=job.assignmentId;
    // Native delegation already pins the child's sandbox and non-interactive approval policy.
    if(root&&data.permissionPreset)ctx.permissionPresets.set(agent.session,data.permissionPreset);
    // The native Agent scope owns these effects. Retain its guards if shutdown fails;
    // completed children release them with their scope instead of accumulating controller references.
    agent.ctx.systemPrompt.section({name:'weft-executor',order:600,interpolate:false,text:()=>`${jobOf(agent)?.instructions??''}${root?'':'\nYou are a delegated worker. Return results to your parent; only the root worker reports or changes the cloud Ticket.'}`});
    const names=[...agent.ctx.tools.view(agent).restrictableNames];
    const allow=names.filter(name=>job.allow.some(pattern=>pattern.endsWith('*')?name.startsWith(pattern.slice(0,-1)):name===pattern));
    const cloudTools=job.tools.filter(tool=>root||tool.name==='orchestrator_read');
    agent.ctx.tools.restrict({allow});
    agent.ctx.on('tools/execute',async(execution,next)=>{
      const current=jobOf(agent);
      if(execution.agent&&execution.agent!==agent)return next();
      if(!current||current.assignmentId!==assignmentId||current.state==='stopped'||current.stopping)throw new Error('Assignment ended');
      if(execution.name!=='run_code'&&!cloudTools.some(tool=>tool.name===execution.name)
        &&(!allow.includes(execution.name)&&!current.allow.some(pattern=>pattern.endsWith('*')?execution.name.startsWith(pattern.slice(0,-1)):execution.name===pattern)))throw new Error('Tool is unavailable to this Executor');
      if(!root&&TOOL_NAMES.has(execution.name)&&execution.name!=='orchestrator_read')throw new Error('Only the root Executor may change the Ticket');
      return next();
    });
    for(const tool of cloudTools){
      if(!TOOL_NAMES.has(tool.name))throw new Error('Unrecognized Executor tool');
      agent.ctx.tools.register({...tool,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
        execute:async(args,execution)=>{
          const current=jobOf(agent);
          if(!current||current.assignmentId!==assignmentId||current.state==='stopped'||current.stopping)throw new Error('Assignment ended');
          const payload={ticketId:current.ticketId,assignmentId:current.assignmentId,requestId:`${agent.id}:${execution.callId}`,name:tool.name,args};
          // Identical tool retries use the native call ID; cloud receipts prevent duplicate reports and replies.
          const result=await post('tool',payload,execution.signal);
          if(tool.name==='orchestrator_report'){
            await change(current,{handoff:args.state!=='progress'||!!args.human_action});
          }
          return result;
        }});
    }
  }
  disposers.push(ctx.on('agent/created',({agent})=>attach(agent)));
  disposers.push(ctx.on('subagent/start',info=>{
    const job=belongs(info.parentSessionId);if(!job)return;
    job.children??={};job.children[info.id]={id:info.id,parentSessionId:info.parentSessionId,runId:info.runId,active:true,local:info.local};
    void change(job,{state:'running'});
  }));
  disposers.push(ctx.on('subagent/end',info=>{
    const job=belongs(info.parentSessionId),child=job?.children?.[info.id];
    if(!job||!child||child.runId!==info.runId)return;
    Object.assign(child,{active:false,stopReason:info.stopReason});
    void change(job,{}).then(()=>settle(job));
  }));
  disposers.push(ctx.on('session/event',(session,event)=>{
    const job=belongs(session.id);if(!job||job.state==='stopped')return;
    if(session.id!==job.sessionId){if(event.type==='turn/start')void change(job,{state:'running'});return;}
    if(event.type==='user/message'){
      const requestId=event.data?.source?.rpcId;
      if(job.requested?.includes(requestId)&&!job.read.includes(requestId)){job.read.push(requestId);void change(job,{});}
    }
    if(event.type==='turn/start')void change(job,{state:'running'});
    if(event.type==='assistant/message'){
      const text=event.data?.message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n');if(text)job.summary=text.slice(-12000);
    }
    if(event.type==='turn/end'&&!job.stopping){
      const failed=event.data?.reason?.kind==='error';
      if(failed){
        const error=event.data.reason.error?.message??'Agent turn failed';
        void cancel(job,{state:'failed',error}).catch(failure=>change(job,{state:'failed',error:`${error}; cleanup incomplete: ${failure}`}));
      }else void change(job,{state:busy(job)&&!job.handoff?'running':'waiting'});
    }
  }));
  async function cancel(job,finish={state:'stopped'}){
    job.stopping=true;await save();
    const agent=ctx.agents.get(job.sessionId),owners=members(job);
    // Native drain closes startup admission and awaits local and external descendants.
    const draining=agent?ctx.subagents.drainDescendants([agent]):Promise.resolve();
    agent?.cancel({kind:'user'},{keepInbox:false});
    const stopProcesses=async()=>{
      const processes=[...new Set([...owners,...members(job)])].flatMap(owner=>ctx.jobs.list(owner).filter(item=>item.owner===owner&&['running','stopping'].includes(item.status)).map(item=>({owner,item})));
      const results=await Promise.allSettled(processes.map(async({owner,item})=>{
        ctx.jobs.kill(item.id,owner,'Assignment ended');
        const settled=await ctx.jobs.wait(item.id,10_000,owner);
        if(['running','stopping'].includes(settled.status))throw new Error('Background process has not stopped; cancellation will be retried');
      }));
      const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
      if(failures.length)throw new AggregateError(failures,'Some Assignment processes have not stopped; cancellation will be retried');
    };
    // Observe the drain immediately, even if process cleanup fails first.
    void draining.catch(()=>{});
    let timer;
    try{
      await Promise.race([Promise.all([draining,stopProcesses()]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Subagent tree has not stopped; cancellation will be retried')),10_000);})]);
    }finally{clearTimeout(timer);}
    await stopProcesses();
    const deadline=Date.now()+10_000,signal=AbortSignal.timeout(10_000);
    while(agent?.status==='running'&&Date.now()<deadline)await sleep(25,signal);
    if(agent?.status==='running')throw new Error('Agent has not stopped; cancellation will be retried');
    const handle=handles.get(job.sessionId);
    if(agent&&!handle)throw new Error('Executor Session is owned by another native caller; restart DSH before retrying');
    await handle?.dispose();handles.delete(job.sessionId);
    for(const child of Object.values(job.children??{}))child.active=false;
    await change(job,finish);
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
    const capacity=data.maxWorkers+(command.byPerson===true?1:0);
    if(typeof command.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,120}$/.test(command.name)||typeof command.instructions!=='string'||command.instructions.length>256*1024
      ||!Array.isArray(command.tools)||command.tools.length>10||!Array.isArray(command.allow)||command.allow.some(name=>typeof name!=='string')
      ||!Array.isArray(command.messages)||command.messages.length>200)throw new Error('Invalid Assignment');
    if(job?.assignmentId!==command.assignmentId&&job&&job.state!=='stopped')await cancel(job);
    if(!job||job.assignmentId!==command.assignmentId){
      if(activeJobs().length>=capacity)return;
      const cwd=resolve(data.root,command.name);
      await mkdir(cwd,{recursive:true});
      const canonical=await realpath(cwd),inside=relative(data.root,canonical);
      if(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw new Error('Task directory escapes the execution root');
      job={ticketId:command.ticketId,assignmentId:command.assignmentId,sessionId,cwd:canonical,revision:0,state:'waiting',accepted:[],requested:[],read:[],tools:command.tools,allow:command.allow,
        instructions:command.instructions.split(command.directory).join(canonical),created:data.jobs[sessionId]?.created??false,children:data.jobs[sessionId]?.children??{},preset:data.jobs[sessionId]?.preset,handoff:false};
      data.jobs[sessionId]=job;await save();
    }
    job.instructions=command.instructions.split(command.directory).join(job.cwd);
    await save();
    // Own the native Agent handle so drain can release it; Retry resumes the same durable Session.
    if(!ctx.agents.get(sessionId)){
      const preset=job.preset??(await ctx.agentPresets.resolve(data.agentPreset||undefined)).id;
      const defaults=ctx.agentDefaultModel;
      const options={agentOptions:{get provider(){return defaults.currentSelection().provider;},get model(){return defaults.currentSelection().model;},get reasoningEffort(){return defaults.currentSelection().reasoningEffort;}},
        setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,preset);}};
      const handle=job.created?await agentOwner.agents.resume({resumeSessionId:sessionId,...options}):await agentOwner.agents.create({sessionId,meta:{cwd:job.cwd,agentPreset:preset},...options});
      handles.set(sessionId,handle);
      await change(job,{created:true,preset});
      await ctx.sessionController.rename({sessionId,title:command.title});
    }
    const live=ctx.agents.get(sessionId);if(live)await attach(live);
    for(const message of command.messages){
      if(typeof message.id!=='string'||typeof message.text!=='string'||message.text.length>256*1024)throw new Error('Invalid task input');
      if(job.accepted.includes(message.id))continue;
      if(job.state!=='running'&&activeJobs().length>=capacity)return;
      if(!job.requested.includes(message.id))job.requested.push(message.id);
      await change(job,{state:'running',handoff:false});
      // The native inbox deduplicates requestId, including a crash before accepted is saved.
      await ctx.sessionController.prompt({sessionId,requestId:message.id,mode:'steer',content:[{type:'text',text:message.text.split(command.directory).join(job.cwd)}]},AbortSignal.timeout(30_000));
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
        if(reply.acknowledged?.length)await save();
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
  const start=()=>{if(closed||!reconciled||!data.endpoint||stop)return;stop=new AbortController();loop=run(stop.signal);};
  const disconnect=async()=>{stop?.abort();await loop;stop=undefined;status='stopped';};
  return {
    inspect:async sessionId=>{
      if(!data.jobs[sessionId])throw new Error('Session does not belong to this Executor');
      const signal=AbortSignal.timeout(5000),agent=ctx.agents.get(sessionId);
      return {state:typeof ctx.sessionController.state==='function'?await ctx.sessionController.state({sessionId},signal):{running:agent?.status==='running'},
        events:agent?.session.snapshotEvents().slice(-40)??[],tree:members(data.jobs[sessionId]).map(id=>({id,resident:!!ctx.agents.get(id),running:ctx.agents.get(id)?.status==='running',jobs:ctx.jobs.list(id).map(({id,status})=>({id,status}))}))};
    },
    snapshot:()=>({state:status,configured:!!data.endpoint,ready:!!data.root&&reconciled,endpoint:data.endpoint,accepting:data.accepting,root:data.root??'',maxWorkers:data.maxWorkers,agentPreset:data.agentPreset??'',permissionPreset:data.permissionPreset??'',
      running:activeJobs().length,jobs:Object.values(data.jobs).map(({ticketId,sessionId,state,cwd,children})=>({ticketId,sessionId,state,cwd,children:Object.values(children??{}).map(({id,parentSessionId,active,stopReason})=>({id,parentSessionId,active,stopReason}))}))}),
    load:()=>serial(async()=>{
      try{
        data=JSON.parse(await readFile(file,'utf8'));
        if(data.endpoint){executorEndpoint(data.endpoint);if(!token.test(data.token??data.pairingKey??''))throw new Error('Invalid Executor credential');}
        if(!isAbsolute(data.root)||!Number.isInteger(data.maxWorkers)||data.maxWorkers<1||data.maxWorkers>16||typeof data.accepting!=='boolean')throw new Error('Invalid Executor configuration');
        for(const job of Object.values(data.jobs)){
          job.children??={};
          if(job.created){
            const rows=await ctx.subagents.listDescendants(job.sessionId,AbortSignal.timeout(10_000));
            if(rows.some(row=>row.kind==='diagnostic'))throw new Error('Cannot reconcile the persisted subagent tree');
            for(const row of rows)job.children[row.id]={...job.children[row.id],id:row.id,parentSessionId:row.parentId,local:row.mode!=='external',active:!!ctx.agents.get(row.id)};
          }
          const live=ctx.agents.get(job.sessionId);if(live)attach(live);
          else if(job.state==='running'||Object.values(job.children).some(child=>child.active))await change(job,{state:'failed',error:'Local DSH restarted during execution. Retry this Ticket to resume its retained Session and files.'});
        }
        start();
      }catch(error){if(error.code!=='ENOENT'){reconciled=false;status='configuration-error';}}
    }),
    pair:input=>serial(async()=>{
      if(Object.values(data.jobs).some(job=>job.state!=='stopped'))throw new Error('Stop or finish existing Assignments before pairing another executor');
      const code=JSON.parse(input.code.trim().startsWith('{')?input.code:Buffer.from(input.code.trim(),'base64url').toString());
      if(code.protocol!==PROTOCOL||!token.test(code.pairingKey??''))throw new Error('Invalid Executor pairing code');
      const endpoint=executorEndpoint(code.endpoint);
      if(!isAbsolute(input.root))throw new Error('Choose an absolute execution directory');
      if(input.permissionPreset&&!['read-only','workspace-write','danger-full-access'].includes(input.permissionPreset))throw new Error('Invalid permission preset');
      await mkdir(input.root,{recursive:true});const root=await realpath(input.root);
      await disconnect();data={endpoint,pairingKey:code.pairingKey,root,accepting:false,maxWorkers:1,jobs:{},agentPreset:input.agentPreset?.trim()??'',permissionPreset:input.permissionPreset??''};
      await save();reconciled=true;start();
    }),
    // The existing authenticated relay carries only a binding credential. Local execution policy is never accepted from it.
    attach:(input,connection)=>serial(async()=>{
      if(!reconciled||!data.root)throw new Error('Configure the task root and execution settings in local DSH first');
      if(connection.state!=='connected'||!connection.endpoint)throw new Error('Connect this DSH to Weft first');
      if(typeof input.code!=='string'||input.code.length>8192)throw new Error('Invalid Executor binding');
      const code=JSON.parse(input.code),endpoint=executorEndpoint(code.endpoint),target=new URL(endpoint),source=new URL(connection.endpoint);
      const tenant=source.pathname.split('/')[3];
      if(code.protocol!==PROTOCOL||!token.test(code.pairingKey??'')||target.origin!==source.origin
        ||target.pathname.split('/')[3]!==tenant)throw new Error('Executor must belong to the connected Weft site and owner');
      if(Object.values(data.jobs).some(job=>job.state!=='stopped'))throw new Error('Stop existing Assignments before changing execution environments');
      await disconnect();data={...data,endpoint,pairingKey:code.pairingKey,jobs:{}};delete data.token;
      await save();start();
    }),
    configure:input=>serial(async()=>{
      if(!reconciled)throw new Error('Repair the Executor configuration before saving');
      if(typeof input.accepting!=='boolean'||!Number.isInteger(input.maxWorkers)||input.maxWorkers<1||input.maxWorkers>16)throw new Error('Invalid execution settings');
      const next={root:input.root??data.root,agentPreset:input.agentPreset??data.agentPreset??'',permissionPreset:input.permissionPreset??data.permissionPreset??''};
      if(typeof next.root!=='string'||!isAbsolute(next.root))throw new Error('Choose an absolute execution directory');
      if(typeof next.agentPreset!=='string'||next.agentPreset.length>256)throw new Error('Invalid Agent preset');
      if(next.permissionPreset&&!['read-only','workspace-write','danger-full-access'].includes(next.permissionPreset))throw new Error('Invalid permission preset');
      if(input.agentPreset!==undefined){const preset=await ctx.agentPresets.resolve(next.agentPreset||undefined);if(preset.broken)throw new Error(preset.broken);}
      await mkdir(next.root,{recursive:true});next.root=await realpath(next.root);
      if(Object.values(data.jobs).some(job=>job.state!=='stopped')&&Object.entries(next).some(([key,value])=>(data[key]??'')!==value))throw new Error('Stop existing Assignments before changing execution settings');
      Object.assign(data,next,{accepting:input.accepting,maxWorkers:input.maxWorkers});await save();
    }),
    reconnect:()=>serial(async()=>{if(!reconciled)throw new Error('Executor configuration or child catalogs could not be reconciled; repair them before reconnecting');await disconnect();start();}),
    disconnect:()=>serial(disconnect),
    close:()=>serial(async()=>{
      closed=true;await disconnect();
      for(const job of Object.values(data.jobs))if(job.state!=='stopped'){
        const failed={state:'failed',error:'Local Executor stopped. Retry the Ticket to resume its retained Session and files.'};
        try{await cancel(job,failed);}catch(error){await change(job,{...failed,error:`${failed.error} Cleanup incomplete: ${error}`});}
      }
      for(const dispose of disposers.reverse())if(typeof dispose==='function')dispose();await saving;
    }),
  };
}
