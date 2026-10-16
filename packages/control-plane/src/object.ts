import { DurableObject } from "cloudflare:workers";
import {
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

export interface TenantEnvironment {
  TENANTS: DurableObjectNamespace<TenantDO>;
}
export const tenantAddress = (tenantId: string): string =>
  JSON.stringify(["tenant", id.parse(tenantId)]);

/** Tenant-owned metadata, immutable executable revisions and discoverable sessions. */
export class TenantDO extends DurableObject<TenantEnvironment> {
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
  private scope(tenantId: string): void {
    if (
      !this.ctx.id.equals(this.env.TENANTS.idFromName(tenantAddress(tenantId)))
    )
      throw new Error("Tenant object scope mismatch");
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
  async state(tenantId: string): Promise<TenantState> {
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
    tenantId: string,
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
    tenantId: string,
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
  async trackSession(tenantId: string, record: SessionRecord): Promise<void> {
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
        title: (JSON.parse(previous.document) as SessionRecord).title,
      };
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      record.id,
      JSON.stringify(record),
    );
    await this.ctx.storage.sync();
  }
  async publishClient(tenantId: string, input: unknown): Promise<Response> {
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
    tenantId: string,
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
  async clientModule(tenantId: string, revision: string): Promise<Response> {
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
