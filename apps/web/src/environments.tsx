import React, { useEffect, useMemo, useState, type ReactNode } from "react";
import YAML from 'yaml';
import { api, post } from "./api.ts";
import { BrandWordmark, Button, DisclosureRow, FishLogo, Input, Modal, Tag, IconCodeOutlineRegular, IconPlusOutlineRegular, IconUserOutlineRegular } from "./runtime/primitives.ts";
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
  const yamlError = useMemo(() => advanced ? syntaxError(configuration) : undefined, [advanced, configuration]);
  const load = async () => setEnvironments((await api<{environments: EnvironmentRecord[]}>("environments")).environments);
  useEffect(() => {void load().catch(error => setError(String(error)));}, []);
  const copying=environments?.some(row=>row.status==='copying')??false;
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
              {React.createElement(environment.status==='copying'||environment.status==='failed'?'div':'a', {className:'home-card',...(environment.status==='copying'||environment.status==='failed'?{}:{'aria-label':`进入 ${environment.name}`,href:`/agents/${environment.id}`})}, <>
                <span className="home-card-mark" aria-hidden><FishLogo size={18} /></span>
                <span className="home-card-body">
                  <span className="home-card-title"><strong>{environment.name}</strong>{environment.id === 'default' && <Tag tone="outline">默认</Tag>}</span>
                  <span className="home-card-meta"><code>{environment.id}</code><span>更新于 {updated.format(new Date(environment.updatedAt))}</span></span>
                </span>
                <span className="home-card-open">{environment.status==='copying' ? `正在复制${environment.copy?.phase==='files'&&environment.copy.total ? ` · ${Math.floor(environment.copy.completed/environment.copy.total*100)}%` : '…'}` : environment.status==='failed' ? '复制未完成' : '进入工作台 →'}</span>
              </>)}
              {environment.status==='failed' && <p className="home-copy-error" role="alert">{environment.copy?.error}</p>}
              <div className="home-card-actions">
                {environment.status==='failed' && environment.copy ? <Button variant="ghost" size="sm" disabled={copyBusy} onClick={()=>{setCopyRetry(true);setCopySource({id:environment.copy!.sourceId,name:environment.name,createdAt:'',updatedAt:''});setCopyName(environment.name);setCopyRequest(environment.copy!.requestId);setCopyError('');}}>重试复制</Button> : environment.status!=='copying' && <Button variant="ghost" size="sm" onClick={()=>{setCopyRetry(false);setCopySource(environment);setCopyName(`${environment.name} 副本`.slice(0,80));setCopyRequest(crypto.randomUUID());setCopyError('');}}>复制</Button>}
              </div>
              </div>
            ))}
        </section>
      </main>
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
