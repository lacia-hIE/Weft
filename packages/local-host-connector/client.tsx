import React,{useEffect,useId,useState,type ReactNode} from 'react';
import {Button,Input,Tag} from '@deepseek-ai/dsh-client-ui-primitives';
import metadata from './package.json' with {type:'json'};
import {connectionStyles} from './client-styles.ts';

const zh={title:'连接设置',description:'通过 Weft 使用本机环境，数据由本地 DSH 管理。',code:'配对码',hint:'在 Weft 首页生成配对码，复制并粘贴到这里。',placeholder:'粘贴配对码',saved:'配置自动保存在本机，无需下载文件。',details:'连接详情',address:'连接地址',hostVersion:'DSH 版本',pair:'保存并连接',reconnect:'重新连接',stop:'停止连接',busy:'正在处理…',failed:'操作失败，请检查配对码或稍后重试。',remote:'请在本机 DSH 页面管理连接。',
  unpaired:'尚未配对',connecting:'正在连接…',connected:'已连接',retrying:'网络中断，正在重试…',revoked:'授权已撤销，请在 Weft 重新配对。',incompatible:'版本不兼容，请更新 DSH 或连接插件。','pairing-rejected':'配对码已过期或使用过，请在 Weft 生成新配对码。','configuration-error':'配置文件无法读取，请重新配对。',stopped:'连接已停止'};
const en:typeof zh={title:'Connection settings',description:'Use this computer through Weft. Your data stays managed by local DSH.',code:'Pairing code',hint:'Generate a pairing code on the Weft home page, then paste it here.',placeholder:'Paste pairing code',saved:'Settings are saved on this computer; no file download is needed.',details:'Connection details',address:'Endpoint',hostVersion:'DSH version',pair:'Save and connect',reconnect:'Reconnect',stop:'Stop connection',busy:'Working…',failed:'The operation failed. Check the pairing code or try again.',remote:'Manage this connection from your local DSH page.',
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
  return <ConnectionSettings t={t}/>;
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
        {state.configured&&<div className="weft-connection-secondary"><Button variant="outline" disabled={busy} onClick={()=>void action('reconnect')}>{busy&&pendingAction==='reconnect'?t('busy'):t('reconnect')}</Button><Button variant="ghost" disabled={busy||state.state==='stopped'} onClick={()=>void action('disconnect')}>{busy&&pendingAction==='disconnect'?t('busy'):t('stop')}</Button></div>}
      </div>
    </form>}
    {error&&<p className="weft-connection-error" role="alert">{error}</p>}
  </section>;
}
