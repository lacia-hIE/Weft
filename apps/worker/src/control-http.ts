import { z } from "zod";
import { pluginCatalog } from "../../../packages/plugin-runtime/src/catalog.ts";
import {
  controlScope, controlFor,
  type TenantEnvironment,
} from "../../../packages/control-plane/src/object.ts";
import { id } from "../../../packages/control-plane/src/contracts.ts";
import type { Principal } from "../../../packages/tenant/src/index.ts";
import { assertSameOrigin, HttpError, readJson } from "./http.ts";
import upstream from "../../../upstream.lock.json";

export async function handleControlRequest(
  request: Request,
  env: TenantEnvironment,
  principal: Principal,
  environmentId?: string,
): Promise<Response | undefined> {
  const match =
    /^\/v1\/tenants\/([^/]+)\/(state|plugins|agents|client-plugins)(?:\/([^/]+)(?:\/(enable|module\.js))?)?$/.exec(
      new URL(request.url).pathname,
    );
  if (!match) return undefined;
  if (match[1] !== principal.tenantId)
    throw new HttpError(403, "Tenant access denied");
  const scope = controlScope(principal.tenantId, environmentId);
  const tenant = controlFor(env, scope);
  const resource = match[2],
    key = match[3],
    action = match[4];
  if (request.method === "GET") {
    if (resource === "state" && !key)
      return Response.json(await tenant.state(scope), {
        headers: { "cache-control": "private, no-store" },
      });
    if (resource === "plugins" && !key)
      return Response.json({
        upstream: upstream.commit,
        plugins: pluginCatalog,
      });
    if (resource === "agents" && key && !action && id.safeParse(key).success) {
      const revisionText = new URL(request.url).searchParams.get("revision");
      const revision = revisionText === null ? undefined : Number(revisionText);
      if (
        revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 1)
      )
        throw new HttpError(400, "Invalid revision");
      const value = await tenant.agent(scope, key, revision);
      if (!value) throw new HttpError(404, "Agent revision not found");
      return Response.json(value);
    }
    if (
      resource === "client-plugins" &&
      key &&
      action === "module.js" &&
      z.uuid().safeParse(key).success
    )
      return tenant.clientModule(scope, key);
  }
  if (request.method === "POST") {
    assertSameOrigin(request);
    const raw = await readJson(
      request,
      resource === "client-plugins" ? 150_000 : 32_768,
    );
    if (resource === "agents" && !key) {
      const payload = z
        .object({
          spec: z.unknown(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict()
        .safeParse(raw);
      if (!payload.success)
        throw new HttpError(400, "Invalid publication body");
      return tenant.publishAgent(
        scope,
        payload.data.spec,
        payload.data.expectedRevision,
      );
    }
    if (resource === "client-plugins" && !key)
      return tenant.publishClient(scope, raw);
    if (
      resource === "client-plugins" &&
      key &&
      action === "enable" &&
      id.safeParse(key).success
    ) {
      const payload = z
        .object({ revision: z.uuid(), enabled: z.boolean() })
        .strict()
        .safeParse(raw);
      if (!payload.success)
        throw new HttpError(400, "Invalid plugin activation body");
      return tenant.enableClient(
        scope,
        key,
        payload.data.revision,
        payload.data.enabled,
      );
    }
  }
  throw new HttpError(404, "Control resource not found");
}
