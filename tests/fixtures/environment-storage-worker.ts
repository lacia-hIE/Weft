import application, {EnvironmentDO as BaseEnvironmentDO, SessionDO as BaseSessionDO, WorkspaceDO as BaseWorkspaceDO, type Env} from '../../apps/worker/src/index.ts';
import {Workspace} from '@cloudflare/computer';
import {Buffer} from 'node:buffer';
import {workspaceAddress,type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
import {sessionAddress, type SessionScope} from '../../packages/tenant/src/index.ts';
import {environmentAddress} from '../../packages/control-plane/src/object.ts';
import type {ControlScope, AgentRevision} from '../../packages/control-plane/src/contracts.ts';
import {ConfigWriteQueue, DurableSettingsDocuments, DurableAgentRevisions} from '../../packages/environment-storage/src/index.ts';
import {DurableCopySnapshots} from '../../packages/control-plane/src/environment-copy.ts';

export * from '../../apps/worker/src/index.ts';

export class WorkspaceDO extends BaseWorkspaceDO {
  async fixtureCopy(operation:string): Promise<Response> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_copy_fault (id INTEGER PRIMARY KEY)');
    const provider=new Workspace({storage:this.ctx.storage,output:false}).provider();
    if(operation==='fail') this.ctx.storage.sql.exec('INSERT OR IGNORE INTO fixture_copy_fault VALUES (1)');
    if(operation==='seed') {
      provider.mkdirSync('/workspace/project/.git',{recursive:true});
      provider.mkdirSync('/workspace/.weft/attachments/v1',{recursive:true});
      provider.mkdirSync('/workspace/.dsh/spill',{recursive:true});
      const bytes=new Uint8Array(3*1024*1024+17);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
      provider.writeFileSync('/workspace/project/数据.bin',Buffer.from(bytes));
      provider.linkSync('/workspace/project/数据.bin','/workspace/project/linked.bin');
      provider.writeFileSync('/workspace/project/empty','');
      provider.writeFileSync('/workspace/project/run.sh','#!/bin/sh\necho copied\n');provider.chmodSync('/workspace/project/run.sh',0o755);
      provider.writeFileSync('/workspace/project/.git/config','[core]\n repositoryformatversion = 0\n');
      provider.writeFileSync('/workspace/.env','PROJECT=value');
      provider.writeFileSync('/workspace/.weft/attachments/v1/private','private-session-attachment');
      provider.writeFileSync('/workspace/.dsh/spill/private','private-session-output');
      for(let i=0;i<5010;i++)provider.writeFileSync(`/workspace/project/file-${String(i).padStart(5,'0')}`,'x');
    }
    if(operation==='inspect') {
      const bytes=provider.readFileSync('/workspace/project/数据.bin') as Uint8Array;
      const linked=provider.readFileSync('/workspace/project/linked.bin') as Uint8Array;
      return Response.json({length:bytes.length,first:bytes[0],last:bytes.at(-1),linkedLength:linked.length,linkedLast:linked.at(-1),empty:provider.statSync('/workspace/project/empty').size,mode:provider.statSync('/workspace/project/run.sh').mode&0o777,count:provider.readdirSync('/workspace/project').length,private:provider.existsSync('/workspace/.weft/attachments/v1/private'),spill:provider.existsSync('/workspace/.dsh/spill/private'),snapshots:this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM weft_copy_volumes').one().count});
    }
    return Response.json({ok:true});
  }
  override async copyAccept(scope:WorkspaceScope,copyId:string,seq:number,page:Response):Promise<void> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_copy_fault (id INTEGER PRIMARY KEY)');
    if(seq===3 && this.ctx.storage.sql.exec('DELETE FROM fixture_copy_fault WHERE id=1 RETURNING id').toArray().length) throw new Error('Injected copy interruption');
    return super.copyAccept(scope,copyId,seq,page);
  }
}

export class SessionDO extends BaseSessionDO {
  override async nativeReadSummaryGroup(scope: SessionScope): Promise<Response> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_summary_reads (id INTEGER PRIMARY KEY,count INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO fixture_summary_reads VALUES (1,1) ON CONFLICT(id) DO UPDATE SET count=count+1');
    return super.nativeReadSummaryGroup(scope);
  }
  async fixtureSummaryReads(): Promise<number> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_summary_reads (id INTEGER PRIMARY KEY,count INTEGER NOT NULL)');
    return this.ctx.storage.sql.exec<{count: number}>('SELECT count FROM fixture_summary_reads WHERE id=1').toArray()[0]?.count ?? 0;
  }
}

/** Real application environment, deliberately given no usable D1 binding. */
export class EnvironmentDO extends BaseEnvironmentDO {
  constructor(ctx: DurableObjectState, env: Env) {
    const localOnly = {...env, CONFIG_DB: undefined};
    super(ctx, localOnly);
  }

  async fixture(scope: ControlScope, operation: string, document?: string): Promise<Response> {
    if(operation==='copy-snapshot-storage') {
      const store=new DurableCopySnapshots(this.ctx.storage),text='x'.repeat(65_535)+'😀'+'z'.repeat(2*1024*1024);
      store.put('large-config',text);
      const equal=store.get('large-config')===text;
      store.delete('large-config');
      return Response.json({equal,removed:store.get('large-config')===undefined});
    }
    // The normal entrypoint never exposes this fixture or these raw writes.
    if (!this.ctx.id.equals(this.env.ENVIRONMENTS.idFromName(environmentAddress(scope)))) throw new Error('Fixture scope mismatch');
    if (operation === 'fail-document') {
      this.ctx.storage.sql.exec("CREATE TRIGGER reject_document BEFORE UPDATE ON weft_settings_documents WHEN NEW.ns='agent-loop' BEGIN SELECT RAISE(ABORT, 'injected document failure'); END");
      return Response.json({installed: true});
    }
    if (operation === 'allow-document') {this.ctx.storage.sql.exec('DROP TRIGGER reject_document'); return Response.json({removed: true});}
    if (operation === 'clear-summaries') {this.ctx.storage.sql.exec('DELETE FROM weft_session_summaries'); return Response.json({cleared: true});}
    if (operation === 'seed-local-workspace') {
      const record = {path: '/workspace', title: 'Kept workspace', sessionIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()};
      this.ctx.storage.sql.exec('CREATE TABLE weft_workspace_registry_state (id INTEGER PRIMARY KEY,document TEXT NOT NULL)');
      this.ctx.storage.sql.exec('CREATE TABLE weft_workspace_registry (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,document TEXT NOT NULL)');
      this.ctx.storage.sql.exec('INSERT INTO weft_workspace_registry_state VALUES (1,?)', JSON.stringify({initialized: true, defaultWorkspaceId: 'kept-id', workspaceIds: ['kept-id'], archivedSessionIds: [], pinnedSessionIds: []}));
      this.ctx.storage.sql.exec('INSERT INTO weft_workspace_registry VALUES (?,?,?)', 'kept-id', record.path, JSON.stringify(record));
      return Response.json({seeded: true});
    }
    if (operation === 'interrupt-workspace') {
      const row = this.ctx.storage.sql.exec<{value: string}>("SELECT value FROM weft_kv_unit_globals WHERE unit='workspace'").one();
      const state = JSON.parse(row.value);
      state.pendingMutation = {operation: 'create', workspaceId: 'interrupted-id'};
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE weft_kv_unit_globals SET value=? WHERE unit='workspace'", JSON.stringify(state));
        this.ctx.storage.sql.exec('INSERT INTO weft_kv_u_workspace_workspaces VALUES (?,?)', 'interrupted-id', JSON.stringify({path: '/workspace/interrupted', title: 'Partial', sessionIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()}));
      });
      return Response.json({interrupted: true});
    }
    if (operation === 'seed-presets') {
      const revisions = JSON.parse(document!) as AgentRevision[];
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM official_preset_seeds');
        this.ctx.storage.sql.exec('DELETE FROM weft_agent_revisions');
        for (const row of revisions) this.ctx.storage.sql.exec('INSERT INTO weft_agent_revisions VALUES (?,?,?)', row.spec.id, row.revision, JSON.stringify(row));
      });
      return Response.json({seeded: true});
    }
    if (operation === 'atomicity') {
      const storage = this.ctx.storage;
      const settings = new DurableSettingsDocuments(storage, new ConfigWriteQueue());
      const key = 'storage-fixture';
      await settings.update(key, () => ({revision: 1, user: {value: 'before'}}));
      storage.sql.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON weft_settings_documents WHEN NEW.ns='storage-fixture' BEGIN SELECT RAISE(ABORT, 'injected settings failure'); END");
      let settingsRejected = false;
      try {await settings.update(key, () => ({revision: 2, user: {value: 'rejected'}}));} catch {settingsRejected = true;}
      storage.sql.exec('DROP TRIGGER reject_settings');
      const afterFailure = settings.get(key);
      const afterRetry = await settings.update(key, current => ({revision: current.revision + 1, user: {value: 'retried'}}));
      await this.nativeWorkspace(scope, 'workspace/initializeDefault', {});
      await this.nativeWorkspace(scope, 'directoryPicker/createDirectory', {path: '/workspace', name: 'rollback'});
      const state = storage.sql.exec<{value: string}>("SELECT value FROM weft_kv_unit_globals WHERE unit='workspace'").one().value;
      const count = storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_kv_u_workspace_workspaces').one().count;
      storage.sql.exec("CREATE TRIGGER reject_workspace BEFORE INSERT ON weft_kv_u_workspace_workspaces BEGIN SELECT RAISE(ABORT, 'injected workspace failure'); END");
      const failed = await (await this.nativeWorkspace(scope, 'workspace/create', {request: {path: '/workspace/rollback'}})).json() as {error?: unknown};
      storage.sql.exec('DROP TRIGGER reject_workspace');
      const workspaceRejected = failed.error !== undefined;
      const stateUnchanged = storage.sql.exec<{value: string}>("SELECT value FROM weft_kv_unit_globals WHERE unit='workspace'").one().value === state;
      const countUnchanged = storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_kv_u_workspace_workspaces').one().count === count;
      const noPartialRow = !storage.sql.exec<{value: string}>('SELECT value FROM weft_kv_u_workspace_workspaces').toArray().some(row => JSON.parse(row.value).path === '/workspace/rollback');
      const presets = new DurableAgentRevisions<{revision: number; value: string}>(storage);
      const first = await presets.publish('storage-fixture', {revision: 1, value: 'before'});
      const duplicate = await presets.publish('storage-fixture', {revision: 1, value: 'rejected'});
      return Response.json({settingsRejected, afterFailure, afterRetry, workspaceRejected, stateUnchanged, countUnchanged, noPartialRow, first, duplicate, preset: presets.latest('storage-fixture')});
    }
    return Response.json({state: await this.state(scope)});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if(new URL(request.url).pathname==='/_fixture/workspace-copy') {
      const {scope,operation}=await request.json() as {scope:WorkspaceScope;operation:string};
      return (env.WORKSPACES.getByName(workspaceAddress(scope)) as DurableObjectStub<WorkspaceDO>).fixtureCopy(operation);
    }
    if (new URL(request.url).pathname === '/_fixture/summary-reads') {
      const scope = await request.json() as SessionScope;
      const target = env.SESSIONS.getByName(sessionAddress(scope)) as DurableObjectStub<SessionDO>;
      return Response.json({reads: await target.fixtureSummaryReads()});
    }
    if (new URL(request.url).pathname === '/_fixture/environment-storage') {
      const input = await request.json() as {scope: ControlScope; operation: string; document?: string};
      const target = env.ENVIRONMENTS.getByName(environmentAddress(input.scope)) as DurableObjectStub<EnvironmentDO>;
      return target.fixture(input.scope, input.operation, input.document);
    }
    return application.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
