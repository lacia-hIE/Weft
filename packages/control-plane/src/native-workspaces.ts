import type { DurableWorkspaceRegistry, WorkspaceTransaction } from '../../environment-storage/src/index.ts';
import { posix } from 'node:path';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { brandString } from '@deepseek-ai/dsh-brand';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { WorkspaceId, SessionActivity } from '@deepseek-ai/dsh-workspace/types';
import type { WorkspaceView, WorkspaceBaseline, WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller/types';
import { workspaceRecord, workspaceDomainState, type WorkspaceRecord, type WorkspaceDomainState } from '@weft/upstream/packages/workspace/workspace/src/spec.ts';
import remote from '../../../.generated/official-remotes/packages/api/workspace-controller/typert.remote-client.js';
import { workspacePath, ROOT, type WorkspaceOperation, type FileInfo } from '../../workspace/src/protocol.ts';
import { NativeStreamHub } from './native-events.ts';

export interface NativeWorkspaceHost {
  files(operation: WorkspaceOperation): Promise<Response>;
  header(id: string): Promise<SessionHeader | undefined>;
  headers(): Promise<SessionHeader[]>;
  activity(id: string): Promise<readonly SessionActivity[]>;
  stop(id: string): Promise<void>;
}
type Method = keyof typeof remote.methods;
const wid = (id: string) => brandString<WorkspaceId>(id);

/** Native records and protocol over an environment's real Computer filesystem. */
export class NativeWorkspaces {
  private readonly feed = new NativeStreamHub<WorkspaceFollowFrame>();
  private tail = Promise.resolve();
  /** The open local SQLite transaction; `commit` publishes only after it succeeds. */
  private tx: WorkspaceTransaction | undefined;
  constructor(private readonly registry: DurableWorkspaceRegistry, private readonly host: NativeWorkspaceHost) {
    this.snapshot();
  }
  private state(): WorkspaceDomainState {
    return workspaceDomainState.parse(JSON.parse((this.tx ?? this.registry).state()));
  }
  private storeState(state: WorkspaceDomainState): void {
    if (!this.tx) throw new Error('Workspace registry writes require a commit');
    this.tx.storeState(JSON.stringify(workspaceDomainState.parse(state)));
  }
  get(id: string): WorkspaceView | undefined {
    const row = (this.tx ?? this.registry).get(id);
    return row ? {workspaceId: wid(id), ...workspaceRecord.parse(JSON.parse(row.document))} : undefined;
  }
  private require(id: string): WorkspaceView {
    const value = this.get(id);
    if (!value) throw new RemoteError('workspace/not-found', 'Workspace not found', {workspaceId: wid(id)});
    return value;
  }
  private save(view: WorkspaceView): void {
    const {workspaceId, ...record} = view;
    const checked = workspaceRecord.parse(record);
    if (!this.tx) throw new Error('Workspace registry writes require a commit');
    this.tx.save({id: workspaceId, path: checked.path, document: JSON.stringify(checked)});
  }
  snapshot(): WorkspaceBaseline {
    const state = this.state();
    const items = state.workspaceIds.map(id => this.require(id));
    const count = this.tx ? this.tx.count() : this.registry.count;
    if (new Set(state.workspaceIds).size !== count || items.length !== count) throw new Error('Native Workspace registry order is corrupt');
    return {items, archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds};
  }
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.open(signal, () => ({type: 'baseline', value: this.snapshot()}));
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => {}, () => {});
    return pending;
  }
  private async commit<T>(operation: () => T): Promise<T> {
    const result = await this.registry.transaction(tx => {
      this.tx = tx;
      try { return operation(); } finally { this.tx = undefined; }
    });
    this.feed.emit({type: 'replace', value: this.snapshot()});
    return result;
  }
  private canonical(path: string): string {
    try { if (!posix.isAbsolute(path)) throw new Error(); return workspacePath(path); }
    catch { throw new RemoteError('workspace/invalid-path', 'Path is outside the environment filesystem', {path}); }
  }
  private async directory(path: string): Promise<void> {
    const response = await this.host.files({type: 'stat', path});
    const payload = await response.json() as {value?: FileInfo | null};
    if (!response.ok || payload.value?.type !== 'directory') throw new RemoteError('workspace/invalid-path', 'Workspace directory does not exist', {path});
  }
  private async create(path: string, defaultWorkspace = false): Promise<{workspace: WorkspaceView; created: boolean}> {
    path = this.canonical(path);
    const existing = this.snapshot().items.find(row => row.path === path);
    if (existing) return {workspace: existing, created: false};
    await this.directory(path);
    const headers = await this.host.headers();
    const id = defaultWorkspace ? 'default' : crypto.randomUUID();
    const now = new Date().toISOString();
    const record: WorkspaceView = {workspaceId: wid(id), path, title: defaultWorkspace ? 'Workspace' : posix.basename(path), sessionIds: headers.filter(header => header.cwd === path).sort((a,b) => b.createdAt-a.createdAt).map(header => header.id), createdAt: now, updatedAt: now};
    return this.commit(() => {
      const state = this.state();
      this.save(record);
      this.storeState({...state, workspaceIds: [wid(id), ...state.workspaceIds], ...(defaultWorkspace ? {defaultWorkspaceId: wid(id)} : {})});
      return {workspace: record, created: true};
    });
  }
  async initializeDefault(): Promise<WorkspaceView | undefined> {
    return this.queue(async () => {
      const state = this.state();
      if (state.defaultWorkspaceId) return this.get(state.defaultWorkspaceId);
      return (await this.create(ROOT, true)).workspace;
    });
  }
  async resolve(id?: string, cwd?: string): Promise<WorkspaceView> {
    if (id && cwd) throw new RemoteError('gateway/bad-request', 'workspaceId and cwd are exclusive', {});
    if (id) return this.require(id);
    if (cwd) return this.queue(async () => (await this.create(cwd)).workspace);
    const value = await this.initializeDefault();
    if (!value) throw new RemoteError('workspace/not-found', 'Default Workspace was deleted; select a Workspace', {workspaceId: wid('default')});
    return value;
  }
  /** The registry Workspace listing a Session, if any. */
  owning(sessionId: string): string | undefined {return this.snapshot().items.find(row => row.sessionIds.includes(SessionId(sessionId)))?.workspaceId;}
  async attach(id: string, sessionId: string): Promise<void> {
    await this.queue(async () => {
      const workspace = this.require(id);
      const header = await this.host.header(sessionId);
      if (!header || header.cwd !== workspace.path) throw new RemoteError('session/workspace-attach-failed', 'Session directory does not match its Workspace', {sessionId: SessionId(sessionId), workspaceId: id});
      await this.commit(() => {
        for (const row of this.snapshot().items) {
          const sessionIds = row.sessionIds.filter(value => value !== sessionId);
          if (row.workspaceId === id) sessionIds.unshift(SessionId(sessionId));
          if (JSON.stringify(sessionIds) !== JSON.stringify(row.sessionIds)) this.save({...row, sessionIds, updatedAt: new Date().toISOString()});
        }
      });
    });
  }
  async invoke(endpoint: string, args: unknown): Promise<Response> {
    return this.queue(async () => {
      let value: unknown;
      switch (endpoint) {
        case 'workspace/create': {
          const {request} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          value = await this.create(request.path); break;
        }
        case 'workspace/rename': {
          const {request} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          const row = this.require(request.workspaceId), title = request.title.trim();
          if (!title) throw new RemoteError('gateway/bad-request', 'Workspace title must not be blank', {});
          if (this.snapshot().items.some(item => item.workspaceId !== row.workspaceId && item.title === title)) throw new RemoteError('workspace/name-conflict', 'Workspace title is already in use', {name: title});
          const workspace = {...row, title, updatedAt: new Date().toISOString()};
          value = await this.commit(() => {this.save(workspace); return {workspace};}); break;
        }
        case 'workspace/delete': {
          const {request} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          this.require(request.workspaceId);
          value = await this.commit(() => {
            this.tx!.delete(request.workspaceId);
            const state = this.state(); this.storeState({...state, workspaceIds: state.workspaceIds.filter(id => id !== request.workspaceId)});
            return {deleted: true};
          }); break;
        }
        case 'workspace/insertBefore': {
          const {request} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          this.require(request.workspaceId); if (request.beforeWorkspaceId) this.require(request.beforeWorkspaceId);
          value = await this.commit(() => {
            const state = this.state(), ids = [...state.workspaceIds];
            if (request.workspaceId !== request.beforeWorkspaceId) {ids.splice(ids.indexOf(request.workspaceId),1); ids.splice(request.beforeWorkspaceId ? ids.indexOf(request.beforeWorkspaceId) : ids.length,0,request.workspaceId);}
            this.storeState({...state, workspaceIds: ids}); return {workspaceIds: ids};
          }); break;
        }
        case 'workspace/insertSessionBefore': {
          const {request} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          const row = this.require(request.workspaceId), ids = [...row.sessionIds];
          if (!ids.includes(request.sessionId) || (request.beforeSessionId && !ids.includes(request.beforeSessionId))) throw new RemoteError('workspace/move-invalid', 'Session or anchor is not in this Workspace', {workspaceId: request.workspaceId, sessionId: request.sessionId, ...(request.beforeSessionId ? {beforeSessionId: request.beforeSessionId} : {})});
          if (request.sessionId !== request.beforeSessionId) {ids.splice(ids.indexOf(request.sessionId),1); ids.splice(request.beforeSessionId ? ids.indexOf(request.beforeSessionId) : ids.length,0,request.sessionId);}
          const workspace = {...row, sessionIds: ids, updatedAt: new Date().toISOString()};
          value = await this.commit(() => {this.save(workspace); return {workspace};}); break;
        }
        case 'workspace/archiveSession': case 'workspace/unarchiveSession': case 'workspace/pinSession': case 'workspace/unpinSession': {
          const method = remote.methods[endpoint];
          const {request} = method.input({strict: true}).create().parse(args);
          if (endpoint === 'workspace/archiveSession' && this.state().archivedSessionIds.includes(request.sessionId)) {
            value = {archivedSessionIds: this.state().archivedSessionIds}; break;
          }
          if (!await this.host.header(request.sessionId)) throw new RemoteError('session/not-found', 'Session not found', {sessionId: request.sessionId});
          if (endpoint === 'workspace/archiveSession' && !('stopActivity' in request && request.stopActivity)) {
            const activity = await this.host.activity(request.sessionId);
            if (activity.length) throw new RemoteError('workspace/session-active', 'Session has active work', {sessionId: request.sessionId, activity});
          }
          value = await this.commit(() => {
            const state = this.state();
            let archived = [...state.archivedSessionIds], pinned = [...state.pinnedSessionIds];
            if (endpoint === 'workspace/archiveSession') {archived = [...new Set([...archived,request.sessionId])]; pinned = pinned.filter(id => id !== request.sessionId);}
            if (endpoint === 'workspace/unarchiveSession') archived = archived.filter(id => id !== request.sessionId);
            if (endpoint === 'workspace/pinSession') {if (archived.includes(request.sessionId)) throw new RemoteError('gateway/bad-request', 'Unarchive the Session before pinning', {}); pinned = [request.sessionId,...pinned.filter(id => id !== request.sessionId)];}
            if (endpoint === 'workspace/unpinSession') pinned = pinned.filter(id => id !== request.sessionId);
            this.storeState({...state, archivedSessionIds: archived, pinnedSessionIds: pinned});
            return endpoint.includes('archive') ? {archivedSessionIds: archived} : {pinnedSessionIds: pinned};
          });
          if (endpoint === 'workspace/archiveSession' && 'stopActivity' in request && request.stopActivity) {
            try {await this.host.stop(request.sessionId);}
            catch {console.warn('weft.workspace.stop.failed', {sessionId: request.sessionId});}
          }
          break;
        }
        case 'directoryPicker/list': {
          const input = remote.methods[endpoint].input({strict: true}).create().parse(args);
          const path = this.canonical(input.path ?? ROOT), response = await this.host.files({type: 'list', path});
          if (!response.ok) throw new RemoteError('directory-picker/unreadable', 'Directory cannot be listed', {path});
          const payload = await response.json() as {value: FileInfo[]};
          const parts = path.slice(ROOT.length).split('/').filter(Boolean);
          const crumbs = [{name: ROOT, path: ROOT, hidden: false}, ...parts.map((name,index) => ({name, path: ROOT+'/'+parts.slice(0,index+1).join('/'), hidden: false}))];
          value = {path, home: ROOT, crumbs, entries: payload.value.filter(item => item.type === 'directory').map(item => ({name: posix.basename(item.path), path: item.path, hidden: posix.basename(item.path).startsWith('.')})), truncated: false}; break;
        }
        case 'directoryPicker/createDirectory': {
          const {path: raw, name} = remote.methods[endpoint].input({strict: true}).create().parse(args);
          const parent = this.canonical(raw);
          if (!name || name === '.' || name === '..' || /[\/\\\0\r\n]/.test(name)) throw new RemoteError('directory-picker/create-failed', 'Name must be one directory segment', {path: parent});
          const path = this.canonical(posix.join(parent,name));
          const exists = await this.host.files({type: 'stat', path});
          if (exists.ok && (await exists.json() as {value: unknown}).value) throw new RemoteError('directory-picker/exists', 'Directory already exists', {path});
          const response = await this.host.files({type: 'mkdir', path});
          if (!response.ok) throw new RemoteError('directory-picker/create-failed', 'Directory creation failed', {path});
          value = path; break;
        }
        case 'directoryPicker/pick': throw new RemoteError('directory-picker/unavailable', 'Use the browser directory picker', {capability: 'native-dialog'});
        default: throw new RemoteError('gateway/method-unavailable', 'Workspace method is not connected', {endpoint});
      }
      return Response.json({value: remote.methods[endpoint as Method].result.create().parse(value)});
    });
  }
}
