import { DurableObject } from "cloudflare:workers";
import {
  environmentCreateSchema,
  environmentScopeSchema,
  type ControlScope,
  type EnvironmentScope,
  type EnvironmentRecord,
  agentSchema,
  clientPluginSchema,
  id,
  type AgentRevision,
  type ClientPlugin,
  type SessionRecord,
  type TenantState,
} from "./contracts.ts";
import { validatePlugins } from "../../plugin-runtime/src/catalog.ts";
import { compileClientPlugin } from "../../client-plugins/src/compiler.ts";
import upstream from "../../../upstream.lock.json";
import { z } from 'zod';
import { NativeEventHub, NativeStreamHub } from './native-events.ts';
import { NativeWorkspaces } from './native-workspaces.ts';
import type { WorkspaceDO } from '../../workspace/src/object.ts';
import type { SessionDO } from '../../../apps/worker/src/index.ts';
import { workspaceAddress } from '../../workspace/src/protocol.ts';
import { sessionAddress, type SessionScope } from '../../tenant/src/index.ts';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import type { SessionControlFrame, SessionProjectionBaseline } from '@deepseek-ai/dsh-api-session-controller/types';
import { remoteStream } from '../../harness-runtime/src/remote-stream.ts';

export interface TenantEnvironment {
  TENANTS: DurableObjectNamespace<TenantDO>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDO>;
  WORKSPACES: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: DurableObjectNamespace<SessionDO>;
}
export const tenantAddress = (tenantId: string): string =>
  JSON.stringify(["tenant", id.parse(tenantId)]);

/** Environment-local Harness configuration, revisions and discoverable sessions. */
abstract class HarnessStateDO extends DurableObject<TenantEnvironment> {
  private readonly nativeEvents = new NativeEventHub();
  private readonly nativeControl = new NativeStreamHub<SessionControlFrame>();
  private nativeWorkspaces: NativeWorkspaces | undefined;
  private workspaces(scope: ControlScope): NativeWorkspaces {
    this.scope(scope);
    if (this.nativeWorkspaces) return this.nativeWorkspaces;
    const owner = typeof scope === 'string' ? {tenantId: scope} : scope;
    const session = (sessionId: string) => {
      const address: SessionScope = {...owner, sessionId};
      return {scope: address, stub: this.env.SESSIONS.getByName(sessionAddress(address))};
    };
    const volume = {...owner, workspaceId: 'default'};
    return this.nativeWorkspaces = new NativeWorkspaces(this.ctx.storage, {
      files: operation => this.env.WORKSPACES.getByName(workspaceAddress(volume)).call(volume, operation),
      header: async id => {const target=session(id); return target.stub.nativeHeader(target.scope);},
      headers: async () => {
        const records = await this.sessionIndex(scope);
        const values = await Promise.all(records.map(async row => {const target=session(row.id); return target.stub.nativeHeader(target.scope);}));
        return values.filter(value => value !== undefined);
      },
      running: async id => {const target=session(id); return (await target.stub.nativeStatus(target.scope))?.running ?? false;},
      cancel: async id => {const target=session(id); await target.stub.nativeCancel(target.scope);},
    });
  }
  async nativeWorkspace(scope: ControlScope, endpoint: string, args: unknown): Promise<Response> {
    const catalog = this.workspaces(scope);
    if (endpoint === 'workspace/initializeDefault') {
      z.object({}).strict().parse(args);
      const workspace = await catalog.initializeDefault();
      return Response.json({value: workspace ? {workspace} : undefined});
    }
    return catalog.invoke(endpoint, args);
  }
  async nativeResolveWorkspace(scope: ControlScope, workspaceId?: string, cwd?: string) {
    return this.workspaces(scope).resolve(workspaceId, cwd);
  }
  async nativeAttachWorkspace(scope: ControlScope, workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaces(scope).attach(workspaceId, sessionId);
  }
  constructor(ctx: DurableObjectState, env: TenantEnvironment) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agents (id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,revision))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_plugins (id TEXT PRIMARY KEY, revision TEXT NOT NULL, enabled INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_revisions (revision TEXT PRIMARY KEY, document TEXT NOT NULL, module TEXT NOT NULL)",
    );
  }
  protected abstract scope(scope: ControlScope): void;
  nativeDefaultModel(scope: ControlScope) {
    this.scope(scope);
    this.ensureDefault();
    return this.latest('default')?.spec.model;
  }
  nativeEvent(scope: ControlScope, event: string, args: readonly unknown[]): void {
    this.scope(scope);
    this.nativeEvents.emit(event, args);
    if (event === 'api-session/added') {
      const {items} = sessionRemote.methods['session/list'].result.create().parse({items: [args[0]]});
      const row = items[0]!;
      if (row.projections?.kind === 'sequenced' && row.projections.asOfSeq >= 0) {
        for (const [key,value] of Object.entries(row.projections.values)) {
          const frame = sessionRemote.methods['session/control'].result.create().parse({type: 'projection', sessionId: row.sessionId, key, value, seq: row.projections.asOfSeq});
          this.nativeControl.emit(frame);
        }
      }
    }
  }
  override async fetch(request: Request): Promise<Response> {
    const body = z.object({operation: z.enum(['native-events','native-workspaces','native-session-control']), scope: z.union([id, environmentScopeSchema])}).strict().parse(await request.json());
    this.scope(body.scope);
    const abort = new AbortController();
    if (request.signal.aborted) abort.abort();
    else request.signal.addEventListener('abort', () => abort.abort(), {once: true});
    if (body.operation === 'native-session-control') {
      const owner = typeof body.scope === 'string' ? {tenantId: body.scope} : body.scope;
      const source = this.nativeControl.open(abort.signal, async () => {
        const projections: Record<string, SessionProjectionBaseline> = {};
        const records = await this.sessionIndex(body.scope);
        await Promise.all(records.map(async row => {
          const scope = {...owner, sessionId: row.id};
          const raw: unknown = await (await this.env.SESSIONS.getByName(sessionAddress(scope)).nativeProjections(scope)).json();
          const value = sessionRemote.methods['session/projections'].result.create().parse(raw);
          if (value?.kind === 'sequenced') projections[row.id] = {asOfSeq: value.asOfSeq, values: value.values};
        }));
        return {type: 'baseline', value: {projections}};
      });
      const codec = sessionRemote.methods['session/control'].result.create();
      return remoteStream(source, abort, value => codec.parse(value));
    }
    return remoteStream(body.operation === 'native-events' ? this.nativeEvents.open(abort.signal) : this.workspaces(body.scope).follow(abort.signal), abort);
  }
  private latest(agentId: string): AgentRevision | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        document: string;
      }>(
        "SELECT document FROM agents WHERE id=? ORDER BY revision DESC LIMIT 1",
        agentId,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.document) as AgentRevision) : undefined;
  }
  private ensureDefault(): void {
    if (this.latest("default")) return;
    const value: AgentRevision = {
      revision: 1,
      publishedAt: new Date().toISOString(),
      upstream: upstream.commit,
      spec: {
        id: "default",
        name: "DeepSeek Assistant",
        persona:
          "You are a helpful assistant. Use the workspace and available plugins to complete the user’s request.",
        workspaceId: "default",
        allowClientPlugins: false,
        plugins: [
          { id: "tool-todo", config: { allowParallelInProgress: false } },
          { id: "tool-skill", config: { catalogDescriptionMaxLength: 500 } },
        ],
      },
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO agents VALUES (?,?,?)",
      "default",
      1,
      JSON.stringify(value),
    );
  }
  async state(tenantId: ControlScope): Promise<TenantState> {
    this.scope(tenantId);
    this.ensureDefault();
    const agents = this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT a.document FROM agents a WHERE revision=(SELECT MAX(revision) FROM agents b WHERE b.id=a.id) ORDER BY id",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as AgentRevision);
    const sessions = this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT document FROM sessions ORDER BY json_extract(document,'$.updatedAt') DESC LIMIT 200",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as SessionRecord);
    const clientPlugins = this.ctx.storage.sql
      .exec<{ document: string; enabled: number }>(
        "SELECT r.document,p.enabled FROM client_plugins p JOIN client_revisions r ON r.revision=p.revision ORDER BY p.id",
      )
      .toArray()
      .map((row) => ({
        ...(JSON.parse(row.document) as ClientPlugin),
        enabled: !!row.enabled,
      }));
    return { agents, sessions, clientPlugins };
  }
  async publishAgent(
    tenantId: ControlScope,
    input: unknown,
    expectedRevision: number,
  ): Promise<Response> {
    this.scope(tenantId);
    this.ensureDefault();
    const parsed = agentSchema.safeParse(input);
    if (!parsed.success)
      return Response.json(
        { error: "Invalid agent definition" },
        { status: 400 },
      );
    try {
      validatePlugins(parsed.data.plugins, parsed.data.workspaceId);
    } catch {
      return Response.json(
        { error: "Invalid native plugin configuration" },
        { status: 400 },
      );
    }
    const current = this.latest(parsed.data.id)?.revision ?? 0;
    if (expectedRevision !== current)
      return Response.json(
        { error: "Agent changed; reload before publishing" },
        { status: 409 },
      );
    if (
      !current &&
      this.ctx.storage.sql
        .exec<{
          count: number;
        }>("SELECT COUNT(DISTINCT id) AS count FROM agents")
        .one().count >= 64
    )
      return Response.json({ error: "Agent limit reached" }, { status: 409 });
    const value: AgentRevision = {
      spec: parsed.data,
      revision: current + 1,
      publishedAt: new Date().toISOString(),
      upstream: upstream.commit,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO agents VALUES (?,?,?)",
      value.spec.id,
      value.revision,
      JSON.stringify(value),
    );
    await this.ctx.storage.sync();
    return Response.json(value);
  }
  async agent(
    tenantId: ControlScope,
    agentId: string,
    revision?: number,
  ): Promise<AgentRevision | undefined> {
    this.scope(tenantId);
    this.ensureDefault();
    id.parse(agentId);
    if (revision === undefined) return this.latest(agentId);
    const row = this.ctx.storage.sql
      .exec<{
        document: string;
      }>(
        "SELECT document FROM agents WHERE id=? AND revision=?",
        agentId,
        revision,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.document) as AgentRevision) : undefined;
  }
  async trackSession(
    tenantId: ControlScope,
    record: SessionRecord,
  ): Promise<void> {
    this.scope(tenantId);
    id.parse(record.id);
    const previous = this.ctx.storage.sql
      .exec<{
        document: string;
      }>("SELECT document FROM sessions WHERE id=?", record.id)
      .toArray()[0];
    if (previous)
      record = {
        ...record,
        title: (JSON.parse(previous.document) as SessionRecord).title || record.title,
      };
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      record.id,
      JSON.stringify(record),
    );
    await this.ctx.storage.sync();
  }
  async sessionIndex(scope: ControlScope): Promise<SessionRecord[]> {
    this.scope(scope);
    return this.ctx.storage.sql.exec<{document: string}>("SELECT document FROM sessions ORDER BY json_extract(document,'$.updatedAt') DESC LIMIT 200").toArray().map(row => JSON.parse(row.document) as SessionRecord);
  }
  async publishClient(
    tenantId: ControlScope,
    input: unknown,
  ): Promise<Response> {
    this.scope(tenantId);
    const parsed = clientPluginSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid client plugin" }, { status: 400 });
    const exists = this.ctx.storage.sql
      .exec("SELECT id FROM client_plugins WHERE id=?", parsed.data.id)
      .toArray().length;
    if (
      !exists &&
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM client_plugins")
        .one().count >= 64
    )
      return Response.json(
        { error: "Client plugin limit reached" },
        { status: 409 },
      );
    let module: string;
    try {
      module = compileClientPlugin(parsed.data.source);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Client compilation failed",
        },
        { status: 400 },
      );
    }
    // Never interpolate source in HTML. It is served as an authenticated ESM response.
    const revision = crypto.randomUUID();
    const value = {
      ...parsed.data,
      revision,
      publishedAt: new Date().toISOString(),
    };
    const size = this.ctx.storage.sql
      .exec<{
        size: number;
      }>(
        "SELECT COALESCE(SUM(length(module)+length(document)),0) AS size FROM client_revisions",
      )
      .one().size;
    if (size + module.length + JSON.stringify(value).length > 10_000_000)
      return Response.json(
        { error: "Client plugin revision storage limit reached" },
        { status: 409 },
      );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO client_revisions VALUES (?,?,?)",
        revision,
        JSON.stringify(value),
        module,
      );
      // New publications are staged. A human enables the exact immutable revision in the UI.
      this.ctx.storage.sql.exec(
        "INSERT INTO client_plugins VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=0",
        value.id,
        revision,
      );
    });
    await this.ctx.storage.sync();
    return Response.json({ ...value, enabled: false });
  }
  async enableClient(
    tenantId: ControlScope,
    pluginId: string,
    revision: string,
    enabled: boolean,
  ): Promise<Response> {
    this.scope(tenantId);
    id.parse(pluginId);
    const row = this.ctx.storage.sql
      .exec<{
        revision: string;
      }>("SELECT revision FROM client_plugins WHERE id=?", pluginId)
      .toArray()[0];
    if (!row)
      return Response.json(
        { error: "Client plugin not found" },
        { status: 404 },
      );
    if (row.revision !== revision)
      return Response.json(
        { error: "Plugin changed; review the current revision" },
        { status: 409 },
      );
    this.ctx.storage.sql.exec(
      "UPDATE client_plugins SET enabled=? WHERE id=?",
      enabled ? 1 : 0,
      pluginId,
    );
    await this.ctx.storage.sync();
    return Response.json({ enabled });
  }
  async clientModule(
    tenantId: ControlScope,
    revision: string,
  ): Promise<Response> {
    this.scope(tenantId);
    const row = this.ctx.storage.sql
      .exec<{
        module: string;
      }>(
        "SELECT r.module FROM client_revisions r JOIN client_plugins p ON r.revision=p.revision WHERE r.revision=? AND p.enabled=1",
        revision,
      )
      .toArray()[0];
    if (!row)
      return Response.json(
        { error: "Enabled client plugin not found" },
        { status: 404 },
      );
    return new Response(row.module, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}

export const environmentAddress = (scope: EnvironmentScope): string => {
  const value = environmentScopeSchema.parse(scope);
  return JSON.stringify(["environment", value.tenantId, value.environmentId]);
};

/** The default environment adopts existing addresses; no historical data is copied. */
export function controlScope(
  tenantId: string,
  environmentId?: string,
): ControlScope {
  return !environmentId || environmentId === "default"
    ? tenantId
    : { tenantId, environmentId };
}
export function controlFor(env: TenantEnvironment, scope: ControlScope) {
  return typeof scope === "string"
    ? env.TENANTS.getByName(tenantAddress(scope))
    : env.ENVIRONMENTS.getByName(environmentAddress(scope));
}

/** Tenant catalogue and the adopted default Harness environment. */
export class TenantDO extends HarnessStateDO {
  protected override scope(scope: ControlScope): void {
    if (
      typeof scope !== "string" ||
      !this.ctx.id.equals(this.env.TENANTS.idFromName(tenantAddress(scope)))
    )
      throw new Error("Tenant object scope mismatch");
  }
  private environmentRows(): EnvironmentRecord[] {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, document TEXT NOT NULL)",
    );
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO environments VALUES (?,?)",
      "default",
      JSON.stringify({
        id: "default",
        name: "我的 Harness",
        createdAt: now,
        updatedAt: now,
      }),
    );
    return this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT document FROM environments ORDER BY id",
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as EnvironmentRecord);
  }
  async environments(tenantId: string): Promise<EnvironmentRecord[]> {
    this.scope(tenantId);
    return this.environmentRows();
  }
  async environment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | undefined> {
    this.scope(tenantId);
    id.parse(environmentId);
    return this.environmentRows().find((row) => row.id === environmentId);
  }
  async createEnvironment(tenantId: string, input: unknown): Promise<Response> {
    this.scope(tenantId);
    const parsed = environmentCreateSchema.safeParse(input);
    if (!parsed.success)
      return Response.json({ error: "Invalid environment" }, { status: 400 });
    const rows = this.environmentRows();
    const environmentId = parsed.data.id ?? crypto.randomUUID();
    if (rows.some((row) => row.id === environmentId))
      return Response.json(
        { error: "Environment already exists" },
        { status: 409 },
      );
    if (rows.length >= 64)
      return Response.json(
        { error: "Environment limit reached" },
        { status: 409 },
      );
    const now = new Date().toISOString();
    const record: EnvironmentRecord = {
      id: environmentId,
      name: parsed.data.name,
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO environments VALUES (?,?)",
      record.id,
      JSON.stringify(record),
    );
    await this.ctx.storage.sync();
    return Response.json(record, { status: 201 });
  }
}

/** Each named Harness environment has a separate SQLite object and Cordis state. */
export class EnvironmentDO extends HarnessStateDO {
  protected override scope(scope: ControlScope): void {
    if (
      typeof scope === "string" ||
      !this.ctx.id.equals(
        this.env.ENVIRONMENTS.idFromName(environmentAddress(scope)),
      )
    )
      throw new Error("Environment object scope mismatch");
  }
}
