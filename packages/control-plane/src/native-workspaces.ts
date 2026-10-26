import {Context} from '@deepseek-ai/cordis';
import Sessions, {SessionId} from '@deepseek-ai/dsh-session';
import WorkspaceRegistry, {WorkspaceId, workspaceDomainSpec, workspaceDomainState, workspaceRecord} from '@deepseek-ai/dsh-workspace';
import {WorkspaceCommands} from '@weft/upstream/packages/api/workspace-controller/src/commands.ts';
import {WorkspaceFeed, workspaceView} from '@weft/upstream/packages/api/workspace-controller/src/feed.ts';
import type {WorkspaceView, WorkspaceFollowFrame} from '@deepseek-ai/dsh-api-workspace-controller/types';
import type {SessionActivity} from '@deepseek-ai/dsh-workspace/types';
import {EnvironmentSessionPersistence, type SearchPersistencePorts} from '../../native-query/src/persistence.ts';
import {mountDurableStorage} from '../../native-storage/src/index.ts';
import {withWorkspaceFiles} from '../../native-environment/src/workspace-fs.ts';
import {posix} from 'node:path';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import remote from '../../../.generated/official-remotes/packages/api/workspace-controller/typert.remote-client.js';
import {workspacePath, ROOT, type WorkspaceOperation, type FileInfo} from '../../workspace/src/protocol.ts';

export interface NativeWorkspaceHost {
  files(operation: WorkspaceOperation): Promise<Response>;
  persistence: SearchPersistencePorts;
  activity(id: string): Promise<readonly SessionActivity[]>;
  stop(id: string): Promise<void>;
}

/** One local import into the original domain; no D1 or cross-layout data is read. */
function adoptLocalRegistry(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const exists = sql.exec("SELECT name FROM sqlite_master WHERE name='weft_workspace_registry_state'").toArray().length;
  if (!exists) return;
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS weft_kv_units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT');
    if (sql.exec("SELECT name FROM weft_kv_units WHERE name='workspace'").toArray().length) return;
    const state = workspaceDomainState.parse(JSON.parse(sql.exec<{document: string}>('SELECT document FROM weft_workspace_registry_state WHERE id=1').one().document));
    const rows = sql.exec<{id: string; document: string}>('SELECT id,document FROM weft_workspace_registry').toArray().map(row => ({id: row.id, record: workspaceRecord.parse(JSON.parse(row.document))}));
    if (state.workspaceIds.length !== rows.length || state.workspaceIds.some(id => !rows.some(row => row.id === id))) throw new Error('Local workspace registry is inconsistent');
    sql.exec('CREATE TABLE IF NOT EXISTS weft_kv_unit_globals (unit TEXT PRIMARY KEY REFERENCES weft_kv_units(name), value TEXT NOT NULL) STRICT');
    sql.exec('CREATE TABLE IF NOT EXISTS weft_kv_u_workspace_workspaces (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT');
    sql.exec('INSERT INTO weft_kv_units VALUES (?,?)', workspaceDomainSpec.name, workspaceDomainSpec.version);
    sql.exec('INSERT INTO weft_kv_unit_globals VALUES (?,?)', workspaceDomainSpec.name, JSON.stringify(state));
    for (const row of rows) sql.exec('INSERT INTO weft_kv_u_workspace_workspaces VALUES (?,?)', row.id, JSON.stringify(row.record));
    sql.exec('DROP TABLE weft_workspace_registry');
    sql.exec('DROP TABLE weft_workspace_registry_state');
  });
}

/** Original WorkspaceRegistry, Commands and Feed over scoped Cloudflare providers. */
export class NativeWorkspaces {
  private readonly ready: Promise<{ctx: Context; commands: WorkspaceCommands; feed: WorkspaceFeed}>;
  constructor(storage: DurableObjectStorage, private readonly host: NativeWorkspaceHost) {
    this.ready = withWorkspaceFiles(host.files, async () => {
      adoptLocalRegistry(storage);
      const ctx = new Context();
      try {
        await ctx.plugin(Sessions);
        await mountDurableStorage(ctx, storage);
        await ctx.plugin(EnvironmentSessionPersistence, host.persistence);
        ctx.on('workspace/session-activity', async ({sessionId}, next) => [...await host.activity(sessionId), ...await next()]);
        ctx.on('workspace/session-stop', ({sessionId}) => host.stop(sessionId));
        await ctx.plugin(WorkspaceRegistry);
        return {ctx, commands: new WorkspaceCommands(ctx), feed: new WorkspaceFeed(ctx)};
      } catch (error) {await ctx.fiber.dispose(); throw error;}
    });
    void this.ready.catch(() => {});
  }
  private run<T>(operation: (world: Awaited<typeof this.ready>) => T | Promise<T>): Promise<T> {
    return withWorkspaceFiles(this.host.files, async () => operation(await this.ready));
  }
  async initializeDefault(): Promise<WorkspaceView | undefined> {
    return this.run(async ({ctx}) => {const value = await ctx.workspaceRegistry.initializeDefault(async () => ROOT); return value && workspaceView(value);});
  }
  configuration(): Promise<{path: string; title: string}[]> {return this.run(({ctx})=>ctx.workspaceRegistry.list().map(row=>({path:row.path,title:row.title})));}
  async importConfiguration(rows: {path:string;title:string}[]): Promise<void> {
    await this.run(async ({commands})=>{
      for(const row of rows) {
        const {workspace}=await commands.create({path:workspacePath(row.path)});
        await commands.rename({workspaceId:workspace.workspaceId,title:row.title});
      }
    });
  }
  async resolve(id?: string, cwd?: string): Promise<WorkspaceView> {
    if (id && cwd) throw new RemoteError('gateway/bad-request', 'workspaceId and cwd are exclusive', {});
    if (cwd) return this.run(async ({commands}) => (await commands.create({path: cwd})).workspace);
    const value = id ? await this.run(({ctx}) => {const row = ctx.workspaceRegistry.get(WorkspaceId(id)); return row && workspaceView(row);}) : await this.initializeDefault() ?? await this.run(async ({ctx}) => {const row = await ctx.workspaceRegistry.resolveByPath(ROOT); return row && workspaceView(row);});
    if (!value) throw new RemoteError('workspace/not-found', 'Select an existing Workspace', {workspaceId: WorkspaceId(id ?? 'default')});
    return value;
  }
  async owning(sessionId: string): Promise<string | undefined> {return this.run(({ctx}) => ctx.workspaceRegistry.list().find(row => row.sessionIds.includes(SessionId(sessionId)))?.id);}
  async attach(id: string, sessionId: string): Promise<void> {
    return this.run(async ({ctx}) => {
      const row = ctx.workspaceRegistry.get(WorkspaceId(id));
      if (!row) throw new RemoteError('workspace/not-found', 'Workspace not found', {workspaceId: WorkspaceId(id)});
      try {await row.attachSession(SessionId(sessionId));}
      catch (error) {throw new RemoteError('session/workspace-attach-failed', 'Session directory does not match its Workspace', {sessionId: SessionId(sessionId), workspaceId: id}, {cause: error});}
    });
  }
  async detach(id:string,sessionId:string):Promise<void> {
    await this.run(async({ctx})=>{await ctx.workspaceRegistry.get(WorkspaceId(id))?.detachSession(SessionId(sessionId));});
  }
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {const {feed} = await this.ready; yield* feed.follow(signal);}
  async invoke(endpoint: string, args: unknown): Promise<Response> {
    return this.run(async ({commands}) => {
      type Method = keyof typeof remote.methods;
      const method = remote.methods[endpoint as Method];
      if (!method) throw new RemoteError('gateway/method-unavailable', 'Workspace method is not connected', {endpoint});
      const parsed = method.input({strict: true}).create().parse(args);
      let value: unknown;
      const name = endpoint.slice('workspace/'.length);
      const supported = ['create', 'rename', 'delete', 'insertBefore', 'insertSessionBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'] as const;
      if (endpoint.startsWith('workspace/') && supported.some(key => key === name) && 'request' in parsed) {
        const call = commands[name as typeof supported[number]] as (request: unknown) => Promise<unknown>;
        value = await call.call(commands, parsed.request);
      } else value = await this.directory(endpoint, args);
      return Response.json({value: method.result.create().parse(value)});
    });
  }
  /** The browser chooser's filesystem backend; workspace mutations belong to DSH. */
  private async directory(endpoint: string, args: unknown): Promise<unknown> {
    if (endpoint === 'directoryPicker/list') {
      const input = remote.methods[endpoint].input({strict: true}).create().parse(args);
      const path = workspacePath(input.path ?? ROOT), response = await this.host.files({type: 'list', path});
      if (!response.ok) throw new RemoteError('directory-picker/unreadable', 'Directory cannot be listed', {path});
      const {value} = await response.json() as {value: FileInfo[]};
      const parts = path.slice(ROOT.length).split('/').filter(Boolean);
      return {path, home: ROOT, crumbs: [{name: ROOT, path: ROOT, hidden: false}, ...parts.map((name, index) => ({name, path: ROOT+'/'+parts.slice(0, index+1).join('/'), hidden: false}))], entries: value.filter(row => row.type === 'directory').map(row => ({name: posix.basename(row.path), path: row.path, hidden: posix.basename(row.path).startsWith('.')})), truncated: false};
    }
    if (endpoint === 'directoryPicker/createDirectory') {
      const {path: raw, name} = remote.methods[endpoint].input({strict: true}).create().parse(args);
      const parent = workspacePath(raw);
      if (!name.trim() || name === '.' || name === '..' || /[\/\\\0\r\n]/.test(name)) throw new RemoteError('directory-picker/create-failed', 'Name must be one directory segment', {path: parent});
      const path = workspacePath(posix.join(parent, name));
      const exists = await this.host.files({type: 'stat', path});
      if (exists.ok && (await exists.json() as {value: unknown}).value) throw new RemoteError('directory-picker/exists', 'Directory already exists', {path});
      if (!(await this.host.files({type: 'mkdir', path})).ok) throw new RemoteError('directory-picker/create-failed', 'Directory creation failed', {path});
      return path;
    }
    throw new RemoteError('directory-picker/unavailable', 'Use the browser directory picker', {capability: 'native-dialog'});
  }
  async dispose(): Promise<void> {await (await this.ready).ctx.fiber.dispose();}
}
