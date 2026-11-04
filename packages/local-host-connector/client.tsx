import React,{useEffect,useId,useState,type ReactNode} from 'react';
import {Button,Input,Switch,Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import metadata from './package.json' with {type:'json'};
import {connectionStyles} from './client-styles.ts';

const zh={title:'连接设置',description:'通过 Weft 使用本机环境，数据由本地 DSH 管理。',code:'配对码',hint:'在 Weft 首页生成配对码，复制并粘贴到这里。',placeholder:'粘贴配对码',saved:'配置自动保存在本机，无需下载文件。',details:'连接详情',address:'连接地址',hostVersion:'DSH 版本',pair:'保存并连接',reconnect:'重新连接',stop:'停止连接',busy:'正在处理…',failed:'操作失败，请检查配对码或稍后重试。',remote:'请在本机 DSH 页面管理连接。',
  executorPermission:'执行权限预设',executorLocalDefault:'使用本机默认权限',
  executor:'Superagent 执行器',executorHint:'接收当前 Weft 环境的任务，在本机运行 Agent。',executorCode:'执行器配对码',executorRoot:'任务根目录（绝对路径）',executorPreset:'DSH Agent 预设',executorPair:'配对执行器',executorAccept:'允许接收任务',executorMax:'最大并发任务',executorSave:'保存执行设置',executorDefault:'使用本机默认预设',executorReady:'已配置，等待 Weft 选择',executorSource:'保存后，在 Weft 的 Superagent → 设置 → 执行中选择这台已连接的 DSH，无需再次配对。',executorSafety:'Agent 使用本机模型、凭据和所选预设的权限。目录不是权限隔离；建议使用独立 DSH profile。',
  unpaired:'尚未配对',connecting:'正在连接…',connected:'已连接',retrying:'网络中断，正在重试…',revoked:'授权已撤销，请在 Weft 重新配对。',incompatible:'版本不兼容，请更新 DSH 或连接插件。','pairing-rejected':'配对码已过期或使用过，请在 Weft 生成新配对码。','configuration-error':'配置文件无法读取，请重新配对。',stopped:'连接已停止'};
const en:typeof zh={title:'Connection settings',description:'Use this computer through Weft. Your data stays managed by local DSH.',code:'Pairing code',hint:'Generate a pairing code on the Weft home page, then paste it here.',placeholder:'Paste pairing code',saved:'Settings are saved on this computer; no file download is needed.',details:'Connection details',address:'Endpoint',hostVersion:'DSH version',pair:'Save and connect',reconnect:'Reconnect',stop:'Stop connection',busy:'Working…',failed:'The operation failed. Check the pairing code or try again.',remote:'Manage this connection from your local DSH page.',
  executorPermission:'Execution permission preset',executorLocalDefault:'Use local default permissions',
  executor:'Superagent Executor',executorHint:'Accept tasks from your Weft environment and run the Agent on this computer.',executorCode:'Executor pairing code',executorRoot:'Task root directory (absolute path)',executorPreset:'DSH Agent preset',executorPair:'Pair executor',executorAccept:'Accept tasks',executorMax:'Maximum concurrent tasks',executorSave:'Save execution settings',executorDefault:'Use local default preset',executorReady:'Configured, ready to select in Weft',executorSource:'Save here, then select this connected DSH in Weft → Superagent → Settings → Execution. No additional pairing is needed.',executorSafety:'Agents use this computer’s model, credentials and preset permissions. Directories do not isolate permissions; use a dedicated DSH profile.',
  unpaired:'Not paired',connecting:'Connecting…',connected:'Connected',retrying:'Network interrupted; retrying…',revoked:'Authorization revoked. Pair again in Weft.',incompatible:'Version incompatible. Update DSH or the connector.','pairing-rejected':'Pairing code expired or already used. Generate a new code in Weft.','configuration-error':'Cannot read the connection file. Pair again.',stopped:'Connection stopped'};
type State={state:string;endpoint?:string;hostVersion?:string;configured?:boolean};
interface Context {
  locale:{register(ns:string,dictionaries:Record<string,typeof zh>):()=>void;bind(ns:string):(key:keyof typeof zh)=>string};
  slots:{inject(name:string,callback:()=>unknown):unknown;register(spec:object,component:(props:Props)=>ReactNode):unknown};
  effect(callback:()=>unknown,label:string):unknown;
}
interface Props {view:'summary'|'page';t:(key:keyof typeof zh)=>string;}
export const inject=['slots','locale'];
export function apply(ctx:Context):void {
  const ns='weft.local-host';ctx.effect(()=>ctx.locale.register(ns,{zh,en}),'weft.local-host: locale');
  ctx.effect(()=>ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:metadata.name,locale:ns,inject:()=>({})},ConnectionCard)),'weft.local-host: bundle settings');
  ctx.effect(()=>ctx.slots.inject('plugins.row.config',()=>ctx.slots.register({name:'plugins.row.config',key:`${metadata.name}#weft-local-host`,locale:ns,inject:()=>({})},ConnectionCard)),'weft.local-host: component settings');
}
function ConnectionCard({view,t}:Props):ReactNode {
  if(view==='summary')return t('description');
  return <><ConnectionSettings t={t}/><ExecutorSettings t={t}/></>;
}

type ExecutorState={state:string;configured?:boolean;ready?:boolean;accepting:boolean;root:string;maxWorkers:number;agentPreset:string;permissionPreset?:string;running:number;jobs?:{ticketId:string;sessionId:string;state:string;cwd:string}[];presets?:{id:string;name?:string;broken?:string}[]};
type ExecutionDraft=Pick<ExecutorState,'root'|'agentPreset'|'accepting'|'maxWorkers'> & {permissionPreset:string};
function ExecutorSettings({t}:{t:Props['t']}):ReactNode {
  const [state,setState]=useState<ExecutorState>({state:'unpaired',accepting:false,root:'',maxWorkers:1,agentPreset:'',running:0});
  const [draft,setDraft]=useState<ExecutionDraft|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const settings=draft??{...state,permissionPreset:state.permissionPreset??''};
  const edit=(next:Partial<ExecutionDraft>)=>setDraft({...settings,...next});
  const id=useId(),remote=location.pathname.includes('/local/web/'),endpoint=new URL('api/weft-executor',document.baseURI).href;
  useEffect(()=>{
    if(remote)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const response=await fetch(endpoint,{signal:abort.signal,cache:'no-store'});if(!response.ok)throw new Error();const value=await response.json() as ExecutorState;if(!abort.signal.aborted)setState(value);}
      catch{if(!abort.signal.aborted)setError(t('failed'));}
      if(!abort.signal.aborted)timer=setTimeout(()=>void poll(),5000);
    };void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[endpoint,remote,t]);
  const action=async(action:string)=>{
    if(busy)return;setBusy(true);setError('');
    try{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...(action==='configure'?{root:settings.root,agentPreset:settings.agentPreset,permissionPreset:settings.permissionPreset,accepting:settings.accepting,maxWorkers:settings.maxWorkers}:{})})});const result=await response.json() as ExecutorState&{error?:string};if(!response.ok)throw new Error(result.error??t('failed'));setState(previous=>({...previous,...result}));if(action==='configure')setDraft(null);}
    catch(error){setError(error instanceof Error?error.message:t('failed'));}finally{setBusy(false);}
  };
  return <section data-weft-local-executor aria-labelledby={id+'-title'} aria-busy={busy}>
    <style>{connectionStyles.replaceAll('[data-weft-local-connection]','[data-weft-local-executor]')}</style>
    <div className="weft-connection-head"><div><h4 id={id+'-title'} className="weft-connection-title">{t('executor')}</h4><p className="weft-connection-description">{t('executorHint')}</p></div>
      <div role="status"><Tag tone={state.state==='connected'?(state.accepting?'success':'neutral'):'quiet'}>{state.ready&&!state.configured?t('executorReady'):t(state.state in zh?state.state as keyof typeof zh:'connecting')}</Tag></div>
    </div>
    {remote?<p className="weft-connection-hint">{t('remote')}</p>:<form className="weft-connection-form" onSubmit={event=>{event.preventDefault();void action('configure');}}>
      <p className="weft-connection-hint">{t('executorSource')}</p>
      <div className="weft-connection-field"><label htmlFor={id+'-root'}>{t('executorRoot')}</label><Input className="weft-connection-input" id={id+'-root'} value={settings.root} placeholder="/path/to/tasks" spellCheck={false} onChange={event=>edit({root:event.target.value})} disabled={busy} required/></div>
      <div className="weft-connection-field"><label htmlFor={id+'-preset'}>{t('executorPreset')}</label><select className="weft-connection-select" id={id+'-preset'} value={settings.agentPreset} onChange={event=>edit({agentPreset:event.target.value})} disabled={busy}>
        <option value="">{t('executorDefault')}</option>{settings.agentPreset&&!state.presets?.some(row=>row.id===settings.agentPreset)&&<option value={settings.agentPreset} disabled>{settings.agentPreset}</option>}
        {state.presets?.map(row=><option key={row.id} value={row.id} disabled={!!row.broken}>{row.name??row.id}{row.broken?' · '+row.broken:''}</option>)}
      </select></div>
      <div className="weft-connection-field"><label htmlFor={id+'-permission'}>{t('executorPermission')}</label><select className="weft-connection-select" id={id+'-permission'} value={settings.permissionPreset} onChange={event=>edit({permissionPreset:event.target.value})} disabled={busy}>
        <option value="">{t('executorLocalDefault')}</option><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option>
      </select></div>
      <p className="weft-connection-hint">{t('executorSafety')}</p>
      <div className="weft-connection-toggle"><span>{t('executorAccept')}</span><Switch checked={settings.accepting} disabled={busy} label={t('executorAccept')} onChange={accepting=>edit({accepting})}/></div>
      <div className="weft-connection-field"><label htmlFor={id+'-max'}>{t('executorMax')}</label><Input className="weft-connection-input" id={id+'-max'} type="number" min={1} max={16} required value={settings.maxWorkers} disabled={busy} onChange={event=>edit({maxWorkers:Number(event.target.value)})}/></div>
      <div className="weft-connection-actions"><Button type="submit" variant="primary" disabled={busy||!settings.root.trim()}>{busy?t('busy'):t('executorSave')}</Button>
        {state.configured&&<div className="weft-connection-secondary"><Button size="sm" variant="outline" disabled={busy} onClick={()=>void action('reconnect')}>{t('reconnect')}</Button><Button size="sm" variant="ghost" disabled={busy||state.state==='stopped'} onClick={()=>void action('disconnect')}>{t('stop')}</Button></div>}
      </div>
      {!!state.jobs?.length&&<ul className="weft-connection-jobs">{state.jobs.map(job=><li key={job.sessionId}><code>{job.ticketId}</code><span>{job.state}</span><div>{job.cwd}</div></li>)}</ul>}
    </form>}
    {error&&<p className="weft-connection-error" role="alert">{error}</p>}
  </section>;
}
function ConnectionSettings({t}:{t:Props['t']}):ReactNode {
  const [state,setState]=useState<State>({state:'connecting'}),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pendingAction,setPendingAction]=useState('');
  const id=useId();
  const tone=state.state==='connected'?'success':['revoked','incompatible','pairing-rejected','configuration-error'].includes(state.state)?'danger':state.state==='retrying'?'warning':state.state==='connecting'?'info':'neutral';
  let destination='';try{if(state.endpoint)destination=new URL(state.endpoint).host;}catch{/* Keep malformed legacy settings inside the folded details. */}
  const remote=location.pathname.includes('/local/web/');
  const endpoint=new URL('api/weft-local-host',document.baseURI).href;
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      clearTimeout(timer);if(controller.signal.aborted||document.hidden)return;
      try{const response=await fetch(endpoint,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error();const next=await response.json() as State;if(!controller.signal.aborted)setState(next);}catch{if(!controller.signal.aborted)setError(t('failed'));}
      if(!controller.signal.aborted&&!document.hidden)timer=setTimeout(()=>void poll(),3000);
    };
    document.addEventListener('visibilitychange',poll);void poll();
    return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',poll);};
  },[endpoint,t]);
  async function action(action:string):Promise<void>{
    if(busy)return;setBusy(true);setPendingAction(action);setError('');
    try{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...(action==='pair'?{code}:{})})});if(!response.ok)throw new Error();setState(await response.json() as State);setCode('');}
    catch{setError(t('failed'));}finally{setBusy(false);setPendingAction('');}
  }
  return <section data-weft-local-connection aria-labelledby={id+'-title'} aria-busy={busy}>
    <style>{connectionStyles}</style>
    <div className="weft-connection-head"><div><h4 id={id+'-title'} className="weft-connection-title">{t('title')}</h4><p className="weft-connection-description">{t('description')}</p></div><div className="weft-connection-status" role="status"><Tag tone={tone}>{t(state.state in zh?state.state as keyof typeof zh:'connecting')}</Tag></div></div>
    {state.endpoint&&<details className="weft-connection-destination"><summary><span className="weft-connection-site">{destination||t('address')}</span><span className="weft-connection-detail-label">{t('details')}</span></summary><dl className="weft-connection-facts"><div><dt>{t('address')}</dt><dd className="weft-connection-address">{state.endpoint}</dd></div>{state.hostVersion&&<div><dt>{t('hostVersion')}</dt><dd>{state.hostVersion}</dd></div>}</dl></details>}
    {remote?<p className="weft-connection-hint">{t('remote')}</p>:<form className="weft-connection-form" onSubmit={event=>{event.preventDefault();if(code.trim())void action('pair');}}>
      <div className="weft-connection-field"><label htmlFor={id+'-code'}>{t('code')}</label><p id={id+'-hint'} className="weft-connection-hint">{t('hint')}</p><Input className="weft-connection-input" id={id+'-code'} aria-describedby={id+'-hint '+id+'-saved'} placeholder={t('placeholder')} type="password" autoComplete="off" spellCheck={false} value={code} onChange={event=>setCode(event.target.value)} disabled={busy}/></div>
      <p id={id+'-saved'} className="weft-connection-note">{t('saved')}</p>
      <div className="weft-connection-actions">
        <Button type="submit" variant="primary" disabled={busy||!code.trim()}>{busy&&pendingAction==='pair'?t('busy'):t('pair')}</Button>
        {state.configured&&<div className="weft-connection-secondary"><Button size="sm" variant="outline" disabled={busy} onClick={()=>void action('reconnect')}>{busy&&pendingAction==='reconnect'?t('busy'):t('reconnect')}</Button><Button size="sm" variant="ghost" disabled={busy||state.state==='stopped'} onClick={()=>void action('disconnect')}>{busy&&pendingAction==='disconnect'?t('busy'):t('stop')}</Button></div>}
      </div>
    </form>}
    {error&&<p className="weft-connection-error" role="alert">{error}</p>}
  </section>;
}
