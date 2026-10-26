import React,{useEffect,useState,type ReactNode} from 'react';
import {Button,Input} from '@deepseek-ai/dsh-client-ui-primitives';
import metadata from './package.json' with {type:'json'};

const zh={title:'Weft 本地连接',description:'将此 DSH 连接到 Weft，在网页使用本机环境。',code:'配对码',hint:'粘贴 Weft 首页生成的配对码，点击「保存并连接」。配置会自动保存在本机，无需下载文件。',pair:'保存并连接',reconnect:'重新连接',stop:'停止连接',busy:'正在处理…',failed:'操作失败，请检查配对码或稍后重试。',remote:'请在本机 DSH 页面管理连接。',
  unpaired:'尚未配对',connecting:'正在连接…',connected:'已连接',retrying:'网络中断，正在重试…',revoked:'授权已撤销，请在 Weft 重新配对。',incompatible:'版本不兼容，请更新 DSH 或连接插件。','pairing-rejected':'配对码已过期或使用过，请在 Weft 生成新配对码。','configuration-error':'配置文件无法读取，请重新配对。',stopped:'连接已停止'};
const en:typeof zh={title:'Weft local connection',description:'Connect this DSH to Weft to use your local environment in the browser.',code:'Pairing code',hint:'Paste the pairing code from Weft, then select Save and connect. Settings are saved on this computer; no file download is needed.',pair:'Save and connect',reconnect:'Reconnect',stop:'Stop connection',busy:'Working…',failed:'The operation failed. Check the pairing code or try again.',remote:'Manage this connection from your local DSH page.',
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
    if(busy)return;setBusy(true);setError('');
    try{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...(action==='pair'?{code}:{})})});if(!response.ok)throw new Error();setState(await response.json() as State);setCode('');}
    catch{setError(t('failed'));}finally{setBusy(false);}
  }
  return <div data-weft-local-connection style={{display:'grid',gap:16}}>
    <p role="status">{t(state.state in zh?state.state as keyof typeof zh:'connecting')}</p>
    {state.endpoint&&<p>{state.endpoint}</p>}
    {remote?<p>{t('remote')}</p>:<>
      <div style={{display:'grid',gap:8}}><label htmlFor="weft-pairing-code">{t('code')}</label><Input id="weft-pairing-code" aria-describedby="weft-pairing-hint" type="password" autoComplete="off" value={code} onChange={event=>setCode(event.target.value)} disabled={busy}/><span id="weft-pairing-hint">{t('hint')}</span></div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <Button variant="primary" disabled={busy||!code.trim()} onClick={()=>void action('pair')}>{busy?t('busy'):t('pair')}</Button>
        <Button variant="outline" disabled={busy||!state.configured} onClick={()=>void action('reconnect')}>{t('reconnect')}</Button>
        <Button variant="outline" disabled={busy||!state.configured||state.state==='stopped'} onClick={()=>void action('disconnect')}>{t('stop')}</Button>
      </div>
    </>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
