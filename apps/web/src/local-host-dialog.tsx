import React,{useState,type ReactNode} from 'react';
import {post} from './api.ts';
import {Button,Input,Modal} from './runtime/primitives.ts';
import type {EnvironmentRecord} from '../../../packages/control-plane/src/contracts.ts';
import {SUPPORTED_DSH_VERSIONS,LOCAL_HOST_BUNDLE} from '../../../packages/local-host-connector/compatibility.mjs';
import localHostPackage from '../../../packages/local-host-connector/package.json' with {type:'json'};
export function LocalHostDialog({environment,onClose,onSaved}:{environment:EnvironmentRecord|null;onClose:()=>void;onSaved:(record:EnvironmentRecord)=>void}):ReactNode {
  const [name,setName]=useState(environment?.name??'我的电脑');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [connection,setConnection]=useState<{endpoint:string;pairingKey:string;expiresAt:number}>();
  const [created,setCreated]=useState(environment??undefined);
  const [copied,setCopied]=useState(false);
  const pairingCode=connection?btoa(JSON.stringify({endpoint:connection.endpoint,pairingKey:connection.pairingKey})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):'';
  async function pair():Promise<void>{
    if(busy||!name.trim())return;setBusy(true);setError('');
    try{
      const record=created??await post<EnvironmentRecord>('environments',{name:name.trim(),kind:'local'});setCreated(record);onSaved(record);
      const me=await(await fetch('/v1/me')).json() as {tenantId:string};
      const pairing=await post<{pairingKey:string;expiresAt:number}>(`environments/${record.id}/local/pairing`,{});
      setConnection({endpoint:`${location.origin}/v1/local-hosts/${me.tenantId}/${record.id}`,...pairing});
    }catch(error){setError(error instanceof Error?error.message:'连接配置创建失败，请重试');}finally{setBusy(false);}
  }
  return <Modal open title={environment?'重新配对本地 DSH':'连接本地 DSH'} closeLabel="关闭" className="home-create-dialog" onClose={()=>{if(!busy)onClose();}}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>{!connection&&<Button variant="primary" disabled={busy||!name.trim()} onClick={()=>void pair()}>{busy?'正在准备…':'生成配对码'}</Button>}</>}>
    <div className="home-create-form">
      {!connection?<><p>使用本机 DSH 的会话、文件、Git、终端和插件。本机需要保持运行，支持 DSH {SUPPORTED_DSH_VERSIONS.join('、')}。旧版请先升级 DSH。</p><label className="home-field-label" htmlFor="local-host-name">环境名称</label><Input id="local-host-name" data-modal-autofocus value={name} disabled={busy||Boolean(environment)} maxLength={80} onChange={event=>setName(event.target.value)} /></>:<>
        <p>配对码将在 {new Date(connection.expiresAt).toLocaleTimeString()} 过期，仅能使用一次。复制后在本机完成以下操作。</p>
        <Button variant="primary" onClick={()=>{void navigator.clipboard.writeText(pairingCode).then(()=>setCopied(true)).catch(()=>setError('无法自动复制，请从下方选中并复制配对码。'));}}>{copied?'已复制配对码':'复制配对码'}</Button>
        <label className="home-field-label" htmlFor="local-host-pairing-code">配对码</label><Input id="local-host-pairing-code" readOnly autoComplete="off" value={pairingCode} onFocus={event=>event.currentTarget.select()}/>
        <ol><li>在本地 <code>dsh web</code> 的「插件 → 添加插件」中输入 <code>{localHostPackage.name}@{localHostPackage.version}</code> 并安装，完成后点击「立即启用」。已安装并启用最新版则跳过此步。</li><li>在本地「插件」列表打开 <code>{localHostPackage.name}</code> 的详情页，在「配对码」中粘贴，点击「保存并连接」。配置由插件自动保存，无需下载文件或重启 DSH。</li><li>连接成功后，回到 Weft 首页进入该环境。本地 DSH 需要保持运行。</li></ol>
        <p>也可<a href={'/downloads/'+LOCAL_HOST_BUNDLE} download>下载本地 Host 插件</a>，在同一安装入口输入下载文件的绝对路径安装。</p>
        <p>当前支持 <code>dsh web</code>，桌面 App 暂未适配。</p>
        <p>已有连接会被撤销；本地数据保留。</p>
      </>}
      {error&&<p className="home-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
