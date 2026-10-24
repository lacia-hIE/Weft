import React, { useEffect, useMemo, useState, type ReactNode } from "react";
import YAML from 'yaml';
import { api, post } from "./api.ts";
import { BrandWordmark, Button, DisclosureRow, FishLogo, Input, Menu, Modal, Tag, IconCodeOutlineRegular, IconPlusOutlineRegular, IconUserOutlineRegular } from "./runtime/primitives.ts";
import {ConfigField} from '@weft/upstream/packages/client/ui-primitives/src/ConfigField.tsx';
import type { EnvironmentRecord } from "../../../packages/control-plane/src/contracts.ts";
import "./environments.css";

/** The catalogue follows the official system palette outside any environment. */
function useSystemTheme(): void {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.body.toggleAttribute("data-ds-dark-theme", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}
const updated = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });
const INITIAL_CONFIGURATION = `# 未列出的条目沿用原版默认值。
- id: workspace-runtime
  config:
    shell: auto
    containerInstance: basic
- id: agent-preset-registry
  config:
    selectedDefault: standard
`;
function syntaxError(text: string): string | undefined {
  try {
    const document = YAML.parseDocument(text);
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) return issue.message;
    const rows: unknown = document.toJS({maxAliasCount: 0}) ?? [];
    if (!Array.isArray(rows)) return '配置必须是由 id 和 config 组成的 YAML 列表。';
  } catch (error) {return error instanceof Error ? error.message : 'YAML 格式无效';}
}

export function Environments({user}: {user: {id: string; email: string}}): ReactNode {
  useSystemTheme();
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [configuration, setConfiguration] = useState(INITIAL_CONFIGURATION);
  const [copySource,setCopySource]=useState<EnvironmentRecord>();
  const [copyName,setCopyName]=useState('');
  const [copyRequest,setCopyRequest]=useState('');
  const [copyError,setCopyError]=useState('');
  const [copyBusy,setCopyBusy]=useState(false);
  const [copyRetry,setCopyRetry]=useState(false);
  const [openMenu,setOpenMenu]=useState<string>();
  const [edit,setEdit]=useState<{environment:EnvironmentRecord;action:'rename'|'suspend'|'delete'}>();
  const [editValue,setEditValue]=useState('');
  const [editError,setEditError]=useState('');
  const [editBusy,setEditBusy]=useState(false);
  const yamlError = useMemo(() => advanced ? syntaxError(configuration) : undefined, [advanced, configuration]);
  const load = async () => setEnvironments((await api<{environments: EnvironmentRecord[]}>("environments")).environments);
  useEffect(() => {void load().catch(error => setError(String(error)));}, []);
  const copying=environments?.some(row=>['copying','pausing','resuming','deleting'].includes(row.status??'ready'))??false;
  useEffect(()=>{
    if(!copying) return;
    const timer=setInterval(()=>{void load().catch(error=>setError(String(error)));},2000);
    return ()=>clearInterval(timer);
  },[copying]);
  async function copy(source: EnvironmentRecord, name:string, requestId:string): Promise<void> {
    if(copyBusy || !name.trim()) return;
    setCopyBusy(true);setCopyError('');
    try {
      const record=await post<EnvironmentRecord>(`environments/${source.id}/copy`,{name,requestId});
      setEnvironments(rows=>[...(rows??[]).filter(row=>row.id!==record.id),record].sort((a,b)=>a.id.localeCompare(b.id)));
      setCopySource(undefined);
    } catch(error) {setCopyError(error instanceof Error?error.message:'复制失败，请重试');}
    finally {setCopyBusy(false);}
  }
  function startEdit(environment:EnvironmentRecord,action:'rename'|'suspend'|'delete'):void {
    setOpenMenu(undefined);setEdit({environment,action});setEditValue(action==='rename'?environment.name:'');setEditError('');
  }
  async function change(environment:EnvironmentRecord,action:'rename'|'suspend'|'resume'|'delete'):Promise<void> {
    if(editBusy)return;
    setEditBusy(true);setEditError('');setError('');
    try {
      const path=`environments/${environment.id}`;
      const record=action==='rename'?await api<EnvironmentRecord>(path,{method:'PATCH',body:JSON.stringify({name:editValue.trim()})}):action==='delete'?await api<EnvironmentRecord>(path,{method:'DELETE'}):await post<EnvironmentRecord>(`${path}/lifecycle`,{action});
      setEnvironments(rows=>(rows??[]).map(row=>row.id===record.id?record:row).filter(row=>row.status!=='deleted'));
      setEdit(undefined);
    } catch(error) {const message=error instanceof Error?error.message:'操作失败，请重试';if(edit)setEditError(message);else setError(message);}
    finally {setEditBusy(false);}
  }
  function statusLabel(environment:EnvironmentRecord):string {
    switch(environment.status){
      case 'copying':return `正在复制${environment.copy?.phase==='files'&&environment.copy.total?` · ${Math.floor(environment.copy.completed/environment.copy.total*100)}%`:'…'}`;
      case 'failed':return '复制未完成';
      case 'pausing':return '正在暂停…';
      case 'paused':return '已暂停';
      case 'resuming':return '正在恢复…';
      case 'deleting':return '正在删除…';
      default:return '进入工作台 →';
    }
  }
  async function create(): Promise<void> {
    if (busy || !name.trim() || yamlError) return;
    setBusy(true); setCreateError('');
    try {
      const record = await post<EnvironmentRecord>("environments", {name, ...(advanced ? {configuration} : {})});
      setEnvironments(rows => [...(rows ?? []), record].sort((left, right) => left.id.localeCompare(right.id)));
      setName(''); setConfiguration(INITIAL_CONFIGURATION); setAdvanced(false); setCreating(false);
    } catch (error) {setCreateError(error instanceof Error ? error.message : '创建失败，请重试');}
    finally {setBusy(false);}
  }
  return (
    <div className="home">
      <header className="home-bar">
        <BrandWordmark size={24} className="home-brand" />
        <div className="home-account">
          <span className="home-avatar" aria-hidden><IconUserOutlineRegular size={18} /></span>
          <span className="home-identity"><span className="home-identity-label">已登录</span><span className="home-email" title={user.email}>{user.email}</span></span>
          <Button variant="ghost" size="sm" onClick={() => location.assign('/cdn-cgi/access/logout')}>退出登录</Button>
        </div>
      </header>
      <main className="home-main">
        <section className="home-intro">
          <div><h1>我的环境</h1><p>每个环境独立保存预设、插件、模型配置、会话与工作区。</p></div>
          <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setCreating(true)}>创建环境</Button>
        </section>
        <div className="home-list-heading"><h2>所有环境</h2>{environments && <span>{environments.length} 个环境</span>}</div>
        {error && <p className="home-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={() => {setError(''); void load().catch(error => setError(String(error)));}}>重试</Button></p>}
        <section className="home-grid" aria-label="环境列表" aria-busy={environments === undefined}>
          {environments === undefined
            ? [0, 1].map(index => <div key={index} className="home-card home-card-loading" aria-hidden />)
            : environments.map(environment => (
              <div key={environment.id} className="home-card-frame">
              {React.createElement(environment.status&&environment.status!=='ready'?'div':'a', {className:'home-card',...(environment.status&&environment.status!=='ready'?{}:{'aria-label':`进入 ${environment.name}`,href:`/agents/${environment.id}`})}, <>
                <span className="home-card-mark" aria-hidden><FishLogo size={18} /></span>
                <span className="home-card-body">
                  <span className="home-card-title"><strong>{environment.name}</strong>{environment.id === 'default' && <Tag tone="outline">默认</Tag>}</span>
                  <span className="home-card-meta"><code>{environment.id}</code><span>更新于 {updated.format(new Date(environment.updatedAt))}</span></span>
                </span>
                <span className="home-card-open">{statusLabel(environment)}</span>
              </>)}
              {environment.status==='failed' && <p className="home-copy-error" role="alert">{environment.copy?.error}</p>}
              {environment.lifecycle?.error && <p className="home-copy-error" role="alert">{environment.lifecycle.error} <Button variant="ghost" size="sm" disabled={editBusy} onClick={()=>void change(environment,environment.lifecycle!.action)}>重试操作</Button></p>}
              <div className="home-card-actions">
                {environment.status==='failed' && environment.copy ? <Button variant="ghost" size="sm" disabled={copyBusy} onClick={()=>{setCopyRetry(true);setCopySource({id:environment.copy!.sourceId,name:environment.name,createdAt:'',updatedAt:''});setCopyName(environment.name);setCopyRequest(environment.copy!.requestId);setCopyError('');}}>重试复制</Button> : (!environment.status||environment.status==='ready') && <Button variant="ghost" size="sm" onClick={()=>{setCopyRetry(false);setCopySource(environment);setCopyName(`${environment.name} 副本`.slice(0,80));setCopyRequest(crypto.randomUUID());setCopyError('');}}>复制</Button>}
                <Menu open={openMenu===environment.id} align="end" portal
                  anchor={<Button variant="ghost" size="sm" aria-label={`${environment.name} 的更多操作`} aria-haspopup="menu" aria-expanded={openMenu===environment.id} onClick={()=>setOpenMenu(openMenu===environment.id?undefined:environment.id)}>更多操作</Button>}
                  items={[
                    {id:'rename',label:'重命名',disabled:Boolean(environment.status&&!['ready','paused'].includes(environment.status))},
                    {id:environment.status==='paused'?'resume':'suspend',label:environment.status==='paused'?'恢复环境':'暂停环境',disabled:Boolean(environment.status&&!['ready','paused'].includes(environment.status))},
                    {id:'separator',type:'separator'},
                    {id:'delete',label:environment.id==='default'?'删除环境（默认环境不可删除）':'删除环境',danger:true,disabled:environment.id==='default'||Boolean(environment.status&&!['ready','paused','failed'].includes(environment.status))},
                  ]}
                  onClose={()=>setOpenMenu(undefined)} onSelect={action=>{setOpenMenu(undefined);if(action==='resume')void change(environment,'resume');else if(action==='rename'||action==='suspend'||action==='delete')startEdit(environment,action);}} />
              </div>
              </div>
            ))}
        </section>
      </main>
      <Modal open={Boolean(edit)} title={edit?.action==='rename'?'重命名环境':edit?.action==='suspend'?'暂停环境':'删除环境'} closeLabel="关闭" className="home-create-dialog" onClose={()=>{if(!editBusy)setEdit(undefined);}}
        footer={<><Button variant="outline" disabled={editBusy} onClick={()=>setEdit(undefined)}>取消</Button><Button type="submit" form="edit-environment" variant="primary" className={edit?.action==='delete'?'home-danger':undefined} disabled={editBusy||(edit?.action==='rename'?!editValue.trim():edit?.action==='delete'?editValue!==edit.environment.name:false)}>{editBusy?'正在提交…':edit?.action==='rename'?'保存':edit?.action==='suspend'?'暂停环境':'删除环境'}</Button></>}>
        <form id="edit-environment" className="home-create-form" aria-busy={editBusy} onSubmit={event=>{event.preventDefault();if(edit)void change(edit.environment,edit.action);}}>
          {edit?.action==='rename'?<><label className="home-field-label" htmlFor="edit-environment-name">环境名称</label><Input id="edit-environment-name" data-modal-autofocus value={editValue} disabled={editBusy} maxLength={80} onChange={event=>setEditValue(event.target.value)} /></>:edit?.action==='suspend'?<p className="home-copy-description">暂停「{edit.environment.name}」会停止智能体、终端和后台任务，保留配置、会话与工作区文件。恢复后可以重新进入环境，终端命令需要重新运行。</p>:<><p className="home-copy-description">删除「{edit?.environment.name}」会永久清除配置、密钥、会话、插件与工作区文件，并停止后台运行。此操作无法撤销。</p><label className="home-field-label" htmlFor="delete-environment-confirm">输入环境名称确认删除</label><Input id="delete-environment-confirm" data-modal-autofocus value={editValue} disabled={editBusy} onChange={event=>setEditValue(event.target.value)} autoComplete="off" /></>}
          {editError&&<p className="home-error" role="alert">{editError}</p>}
        </form>
      </Modal>
      <Modal open={creating} title="创建环境" closeLabel="关闭" description="为新的环境命名，或使用 YAML 自定义初始配置。" className="home-create-dialog" onClose={() => {if (!busy) setCreating(false);}}
        footer={<><Button variant="outline" disabled={busy} onClick={() => setCreating(false)}>取消</Button><Button type="submit" form="create-environment" variant="primary" disabled={busy || !name.trim() || Boolean(yamlError)}>{busy ? '正在创建…' : '创建环境'}</Button></>}>
        <form id="create-environment" className="home-create-form" aria-busy={busy} onSubmit={event => {event.preventDefault(); void create();}}>
          <label className="home-field-label" htmlFor="environment-name">环境名称</label>
          <Input id="environment-name" placeholder="例如：日常开发、项目研究" data-modal-autofocus value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={80} />
          <DisclosureRow icon={<IconCodeOutlineRegular size={16} />} title="使用 YAML 自定义配置（可选）" open={advanced} expandable={!busy} expandOnRowClick onToggle={() => setAdvanced(value => !value)}>
            <div className="home-yaml">
              <p>使用与设置页面相同的 profile.yml 格式，编辑已接通条目的 id 和 config。未列出的条目使用默认配置，模型密钥请在创建后的 Models 设置中添加。</p>
              <ConfigField label="初始配置 YAML" value={configuration} secret={false} choices={[]} disabled={busy} overridden={configuration !== INITIAL_CONFIGURATION} invalid={Boolean(yamlError)} labels={{reset: '恢复示例', inherited: '默认', invalid: yamlError ?? ''}} onChange={value => {setConfiguration(value); setCreateError('');}} onReset={() => setConfiguration(INITIAL_CONFIGURATION)} />
            </div>
          </DisclosureRow>
          {createError && <p className="home-error" role="alert">{createError}</p>}
        </form>
      </Modal>
      <Modal open={Boolean(copySource)} title="复制环境" closeLabel="关闭" description="复制配置、预设、插件声明和工作区文件，创建独立的新环境。" className="home-create-dialog" onClose={()=>{if(!copyBusy)setCopySource(undefined);}}
        footer={<><Button variant="outline" disabled={copyBusy} onClick={()=>setCopySource(undefined)}>取消</Button><Button type="submit" form="copy-environment" variant="primary" disabled={copyBusy||!copyName.trim()}>{copyBusy?'正在提交…':'复制环境'}</Button></>}>
        <form id="copy-environment" className="home-create-form" aria-busy={copyBusy} onSubmit={event=>{event.preventDefault();if(copySource)void copy(copySource,copyName,copyRequest);}}>
          <label className="home-field-label" htmlFor="copy-environment-name">新环境名称</label>
          <Input id="copy-environment-name" data-modal-autofocus value={copyName} disabled={copyBusy||copyRetry} maxLength={80} onChange={event=>setCopyName(event.target.value)} />
          <p className="home-copy-description">不复制会话历史、受管模型密钥、账号授权或运行中的任务。第三方插件需要重新确认启用。工作区中的 .env 等文件会随文件一起复制；容器内尚未持久化的依赖不包含在内。</p>
          {copyError&&<p className="home-error" role="alert">{copyError}</p>}
        </form>
      </Modal>
    </div>
  );
}
