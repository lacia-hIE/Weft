import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import {
  Miniflare,
  Request as MiniflareRequest,
  Response as MiniflareResponse,
  convertV4MiniflareOptions,
  type V4FetchHandler,
} from "miniflare";

class FixtureEnvironmentMissing extends Error {}

export const accessAudience = "weft-test-app";
export const accessTeamDomain = "test.cloudflareaccess.com";
export const users = {
  alpha: { user_uuid: "user-alpha", email: "alpha@example.com" },
  beta: { user_uuid: "user-beta", email: "beta@example.com" },
};
export type User = keyof typeof users;
export function tenantId(user: User): string {
  return (
    "user-" +
    createHash("sha256")
      .update(JSON.stringify([accessTeamDomain, users[user].user_uuid]))
      .digest("hex")
  );
}
export function url(user: string, path: string): string {
  return `http://${user}.local${path}`;
}
export function sessionPath(
  user: User,
  sessionId: string,
  operation: "messages" | "events" | "cancel",
): string {
  return `/v1/tenants/${tenantId(user)}/sessions/${sessionId}/${operation}`;
}

/**
 * Apply `migrations/*.sql` to the runtime's platform database the way
 * `cf d1 migrations apply` does: each file runs once, recorded in
 * `d1_migrations`, so persisted test directories keep their schema across restarts.
 */
export async function applyConfigMigrations(runtime: Miniflare, worker = 'alpha'): Promise<void> {
  const db = await runtime.getD1Database('CONFIG_DB', worker);
  await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{name: string}>()).results.map(row => row.name));
  const directory = resolve(import.meta.dirname, '../../migrations');
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const statements = readFileSync(resolve(directory, file), 'utf8').replace(/--.*$/gm, '').split(';').map(statement => statement.trim()).filter(Boolean);
    await db.batch([...statements.map(statement => db.prepare(statement)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file)]);
  }
}

/** The official LLM title row's instruction; every new native Session sends one such request. */
export const TITLE_INSTRUCTION = 'Create a concise title for an AI coding-assistant session';
export const FIXTURE_TITLE = 'Fixture session title';

/**
 * Answer the official `session-title-llm` request before a test's own model
 * fixture sees it, so scripted model responses stay aligned with agent turns.
 */
function answerTitleRequests(outbound: V4FetchHandler): V4FetchHandler {
  return async (request, miniflare) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/v1/messages')) {
      // Read the body once and hand the fixture a rebuilt request: a cloned body intermittently reports itself already read under concurrent requests.
      const text = await request.text();
      const body = (() => { try { return JSON.parse(text) as {system?: unknown}; } catch { return undefined; } })();
      if (JSON.stringify(body?.system ?? '').includes(TITLE_INSTRUCTION)) {
        const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
        return new MiniflareResponse(
          event('message_start', {message: {usage: {input_tokens: 5, output_tokens: 0}}})
          + event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}})
          + event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: FIXTURE_TITLE}})
          + event('content_block_stop', {index: 0})
          + event('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}),
          {headers: {'content-type': 'text/event-stream'}},
        );
      }
      return outbound(new MiniflareRequest(request.url, {method: request.method, headers: request.headers, body: text}), miniflare);
    }
    return outbound(request, miniflare);
  };
}

export function createRuntime(
  persist?: string,
  model: {
    bindings?: Record<string, string>;
    outbound?: V4FetchHandler;
    browser?: boolean;
    images?: boolean;
    scriptPath?: string;
    configureModel?: boolean;
    packages?: boolean;
    packageBuilder?: V4FetchHandler;
  } = {},
): Miniflare {
  const profiles = [
    { name: "alpha", access: { aud: accessAudience, identity: users.alpha } },
    { name: "beta", access: { aud: accessAudience, identity: users.beta } },
    { name: "anonymous", access: undefined },
    {
      name: "wrong-app",
      access: { aud: "another-app", identity: users.alpha },
    },
    {
      name: "service",
      access: {
        aud: accessAudience,
        identity: { common_name: "service.access", sub: "" },
      },
    },
    {
      name: "no-user-id",
      access: { aud: accessAudience, identity: { email: users.alpha.email } },
    },
    {
      name: "renamed",
      access: {
        aud: accessAudience,
        identity: { ...users.alpha, email: "renamed@example.com" },
      },
    },
    {
      name: "claims",
      access: {
        aud: accessAudience,
        identity: { sub: users.alpha.user_uuid, email: users.alpha.email },
      },
    },
  ];
  const options = convertV4MiniflareOptions({
    workers: [
      ...profiles
        .filter((profile) => !model.browser || profile.name === "alpha")
        .map((profile) => ({
          name: profile.name,
          serviceBindings: { UI: "assets", ...(model.packageBuilder ? {PLUGIN_BUILDER: model.packageBuilder} : {}) },
          ...(model.packages ? {r2Buckets: {PLUGIN_ARTIFACTS: 'weft-plugin-artifacts'}} : {}),
          routes: [`${profile.name}.local/*`],
          modules: true,
          scriptPath: resolve(model.scriptPath ?? "dist/test-worker.js"),
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat", "enable_request_signal", "durable_object_io_tasks_prevent_eviction"],
          workerLoaders: {LOADER: {}},
          d1Databases: {CONFIG_DB: 'weft-config'},
          ...(model.images ? {images: {binding: 'IMAGES'}} : {}),
          durableObjects: {
            SESSIONS: {
              className: "SessionDO",
              scriptName: "alpha",
              useSQLite: true,
            },
            WORKSPACES: {
              className: "WorkspaceDO",
              scriptName: "alpha",
              useSQLite: true,
            },
            ENVIRONMENTS: { className: "EnvironmentDO", scriptName: "alpha", useSQLite: true },
            GATEWAYS: { className: "ConnectionGatewayDO", scriptName: "alpha", useSQLite: true },
            TENANTS: {
              className: "TenantDO",
              scriptName: "alpha",
              useSQLite: true,
            },
          },
          bindings: {
            ACCESS_AUD: accessAudience,
            ACCESS_TEAM_DOMAIN: accessTeamDomain,
            MODEL_BACKEND: "scripted",
            ...Object.fromEntries(Object.entries(model.bindings ?? {}).filter(([name]) => model.configureModel === false || !['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'TENANT_MODEL_CONFIG_JSON', 'MODEL_IDLE_TIMEOUT_MS'].includes(name))),
          },
          ...(model.outbound ? { outboundService: answerTitleRequests(model.outbound) } : {}),
          ...(profile.access ? { access: profile.access } : {}),
        })),
      {
        name: "assets",
        modules: true,
        scriptPath: resolve("dist/assets-worker.js"),
        compatibilityDate: "2026-07-30",
        assets: { directory: resolve("dist/public"), binding: "ASSETS", run_worker_first: true, routerConfig: {has_user_worker: true}, assetConfig: {html_handling: "none", not_found_handling: "none"} },
      },
    ],
  });
  for (const worker of options.workers)
    worker.dev = { ...worker.dev, unsafeRegisterWorker: false };
  const runtime = new Miniflare({
    ...options,
    ...(persist ? { resourcePersistencePath: persist } : {}),
  });
  // The platform catalogue's D1 schema uses the same migrations as a deployment.
  // Only application requests wait: Miniflare's own binding proxies (the D1 handle
  // the migration uses) travel through dispatchFetch too.
  const migrated = runtime.ready.then(() => applyConfigMigrations(runtime));
  // A runtime disposed before its first application request leaves the migration unobserved.
  migrated.catch(() => { /* Application requests that await it still see the failure. */ });
  const dispatchMigrated = runtime.dispatchFetch.bind(runtime);
  runtime.dispatchFetch = (async (input, init) => {
    const address = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input));
    if (address.hostname.endsWith('.local')) await migrated;
    return dispatchMigrated(input, init);
  }) as typeof runtime.dispatchFetch;
  // Test fixture credentials are entered through the real settings APIs, never
  // read by the application from bindings. Production browser tests use worker.js.
  if (model.configureModel !== false && model.bindings?.MODEL_BACKEND === 'deepseek') {
    const dispatch = runtime.dispatchFetch.bind(runtime);
    const initialized = new Map<string, Promise<void>>();
    runtime.dispatchFetch = (async (input, init) => {
      const address = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input));
      const match = /^\/v1\/tenants\/([^/]+)(?:\/environments\/([^/]+))?/.exec(address.pathname);
      const user = address.hostname === 'beta.local' ? 'beta' : ['alpha.local', 'renamed.local', 'claims.local'].includes(address.hostname) ? 'alpha' : undefined;
      if (user && match?.[1] === tenantId(user)) {
        const environment = match[2] ?? 'default';
        const target = `${user}/${environment}`;
        let ready = initialized.get(target);
        if (!ready) {
          ready = (async () => {
            const rpc = async <T = unknown>(method: string, args: unknown): Promise<T> => {
              const response = await dispatch(url(user, `/v1/tenants/${tenantId(user)}/environments/${environment}/native/api/${method}`), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'client-request', rpcId: 'fixture-settings', method, payload: {args}})});
              if (response.status === 404) throw new FixtureEnvironmentMissing();
              if (!response.ok) throw new Error(`Fixture settings HTTP ${response.status}`);
              const value = await response.json() as {result: {ok: boolean; value: T; error?: unknown}};
              if (!value.result.ok) throw new Error(`Fixture settings rejected: ${JSON.stringify(value.result.error)}`);
              return value.result.value;
            };
            const description = await rpc<{namespaces: {ns: string; revision: number}[]}>('settings/describe', {});
            const provider = description.namespaces.find((row: {ns: string}) => row.ns === 'llm-deepseek');
            if (!provider) throw new Error('Missing native model settings');
            if (provider.revision !== 0) return; // Existing user settings survive runtime restarts.
            let credential = model.bindings!.DEEPSEEK_API_KEY;
            let selection = model.bindings!.DEEPSEEK_MODEL;
            if (model.bindings!.TENANT_MODEL_CONFIG_JSON) {
              const registry = JSON.parse(model.bindings!.TENANT_MODEL_CONFIG_JSON);
              credential = registry[tenantId(user)]?.apiKey;
              selection = registry[tenantId(user)]?.model;
            }
            if (credential) await rpc('credentials/set', {ref: 'DEEPSEEK_API_KEY', value: credential});
            await rpc('settings/update', {ns: 'llm-deepseek', patch: {baseURL: model.bindings!.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic', ...(model.bindings!.MODEL_IDLE_TIMEOUT_MS ? {streamIdleTimeoutMs: Number(model.bindings!.MODEL_IDLE_TIMEOUT_MS)} : {})}, expectedRevision: 0});
            if (selection) await rpc('settings/update', {ns: 'agent-default-model', patch: {provider: 'deepseek-official', model: selection}, expectedRevision: 0});
          })();
          initialized.set(target, ready);
        }
        try {await ready;} catch (error) {
          initialized.delete(target);
          if (!(error instanceof FixtureEnvironmentMissing)) throw error;
        } // Let the real request report unknown environments.
      }
      return dispatch(input, init);
    }) as typeof runtime.dispatchFetch;
  }
  return runtime;
}

export function send(
  runtime: Miniflare,
  user: User,
  sessionId: string,
  text: string,
  caller: string = user,
) {
  return runtime.dispatchFetch(
    url(caller, sessionPath(user, sessionId, "messages")),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
}

export interface EventRecord {
  type: string;
  seq: number;
  data: {
    turn?: number;
    step?: number;
    reason?: { kind: string };
    message?: { content: { type: string; text?: string }[] };
    content?: { type: string; text?: string }[];
  };
}
export interface SessionResponse {
  tenantId: string;
  sessionId: string;
  events: EventRecord[];
}
