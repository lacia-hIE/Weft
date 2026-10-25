import React,{useState,type ReactNode} from 'react';
import {post} from './api.ts';
import {Button,Input,Modal} from './runtime/primitives.ts';
import type {EnvironmentRecord} from '../../../packages/control-plane/src/contracts.ts';
import {SUPPORTED_DSH_VERSIONS,LOCAL_HOST_BUNDLE} from '../../../packages/local-host-connector/compatibility.mjs';
export function LocalHostDialog({environment,onClose,onSaved}:{environment:EnvironmentRecord|null;onClose:()=>void;onSaved:(record:EnvironmentRecord)=>void}):ReactNode {
  const [name,setName]=useState(environment?.name??'我的电脑');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [connection,setConnection]=useState<{endpoint:string;pairingKey:string;expiresAt:number}>();
  const [created,setCreated]=useState(environment??undefined);
  const [copied,setCopied]=useState(false);
  async function pair():Promise<void>{
    if(busy||!name.trim())return;setBusy(true);setError('');
    try{
      const record=created??await post<EnvironmentRecord>('environments',{name:name.trim(),kind:'local'});setCreated(record);onSaved(record);
      const me=await(await fetch('/v1/me')).json() as {tenantId:string};
      const pairing=await post<{pairingKey:string;expiresAt:number}>(`environments/${record.id}/local/pairing`,{});
      setConnection({endpoint:`${location.origin}/v1/local-hosts/${me.tenantId}/${record.id}`,...pairing});
    }catch(error){setError(error instanceof Error?error.message:'连接配置创建失败，请重试');}finally{setBusy(false);}
  }
  function download():void {
    if(!connection)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({endpoint:connection.endpoint,pairingKey:connection.pairingKey},null,2)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='weft-connection.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <Modal open title={environment?'重新配对本地 DSH':'连接本地 DSH'} closeLabel="关闭" className="home-create-dialog" onClose={()=>{if(!busy)onClose();}}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>{connection?<Button variant="primary" onClick={download}>下载连接配置</Button>:<Button variant="primary" disabled={busy||!name.trim()} onClick={()=>void pair()}>{busy?'正在准备…':'生成连接配置'}</Button>}</>}>
    <div className="home-create-form">
      {!connection?<><p>使用本机 DSH 的会话、文件、Git、终端和插件。本机需要保持运行，支持 DSH {SUPPORTED_DSH_VERSIONS.join('、')}。</p><label className="home-field-label" htmlFor="local-host-name">环境名称</label><Input id="local-host-name" data-modal-autofocus value={name} disabled={busy||Boolean(environment)} maxLength={80} onChange={event=>setName(event.target.value)} /></>:<>
        <p>配对配置将在 {new Date(connection.expiresAt).toLocaleTimeString()} 过期，仅能使用一次。下载后在本机完成以下操作。</p>
        <Button variant="outline" onClick={()=>{void navigator.clipboard.writeText(btoa(JSON.stringify({endpoint:connection.endpoint,pairingKey:connection.pairingKey})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')).then(()=>setCopied(true)).catch(()=>setError('无法复制，请下载连接配置。'));}}>{copied?'已复制配对码':'复制配对码'}</Button>
        <ol><li><a href={'/downloads/'+LOCAL_HOST_BUNDLE} download>下载本地 Host 插件</a>，在本地 <code>dsh web</code> 的「插件」页通过下载文件的绝对路径安装组合包。</li><li>打开本地「插件 → Weft 本地连接」，粘贴配对码并连接，无需重启 DSH。</li><li>回到首页进入该环境。也可将下载配置保存为 <code>~/.dsh/weft-connection.json</code>，仅允许自己读取。</li></ol>
        <p>已有连接会被撤销；本地数据保留。</p>
      </>}
      {error&&<p className="home-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
