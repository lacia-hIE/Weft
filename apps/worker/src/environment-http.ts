import type { TenantDO, TenantEnvironment } from "../../../packages/control-plane/src/object.ts";
import type { EnvironmentRecord } from "../../../packages/control-plane/src/contracts.ts";
import { tenantAddress } from "../../../packages/control-plane/src/object.ts";
import { id } from "../../../packages/control-plane/src/contracts.ts";
import type { Principal } from "../../../packages/tenant/src/index.ts";
import { assertSameOrigin, HttpError, readJson } from "./http.ts";

/**
 * Only ready environments are cached. Copying/failed drafts always consult the
 * catalogue so publication is visible immediately after completion.
 */
const confirmed = new Map<string, {record: EnvironmentRecord; at: number}>();
const CONFIRMATION_MS = 60_000;
async function knownEnvironment(tenant: DurableObjectStub<TenantDO>, tenantId: string, environmentId: string): Promise<EnvironmentRecord | undefined> {
  const key = JSON.stringify([tenantId, environmentId]);
  const cached = confirmed.get(key);
  if (cached && Date.now() - cached.at < CONFIRMATION_MS) return structuredClone(cached.record);
  const record = await tenant.environment(tenantId, environmentId);
  if (record && (!record.status || record.status==='ready')) {
    if (confirmed.size >= 1024) confirmed.clear();
    confirmed.set(key, {record: structuredClone(record), at: Date.now()});
  }
  return record;
}

/** Resolve the authenticated environment before any resource is addressed. */
export async function resolveEnvironmentRequest(
  request: Request,
  env: TenantEnvironment,
  principal: Principal,
): Promise<{ request: Request; environmentId?: string; response?: Response }> {
  const url = new URL(request.url);
  const match =
    /^\/v1\/tenants\/([^/]+)\/environments(?:\/([^/]+)(\/.*)?)?$/.exec(
      url.pathname,
    );
  if (!match) return { request };
  if (match[1] !== principal.tenantId)
    throw new HttpError(403, "Tenant access denied");
  const tenant = env.TENANTS.getByName(tenantAddress(principal.tenantId));
  if (!match[2]) {
    if (request.method === "GET")
      return {
        request,
        response: Response.json(
          { environments: await tenant.environments(principal.tenantId) },
          { headers: { "cache-control": "private, no-store" } },
        ),
      };
    if (request.method === "POST") {
      assertSameOrigin(request);
      return {
        request,
        response: await tenant.createEnvironment(
          principal.tenantId,
          await readJson(request, 131_072),
        ),
      };
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (!id.safeParse(match[2]).success)
    throw new HttpError(400, "Invalid environment identity");
  const record = await knownEnvironment(tenant, principal.tenantId, match[2]);
  if (!record) throw new HttpError(404, "Environment not found");
  if (!match[3] && request.method === "GET")
    return { request, response: Response.json(record,{headers:{'cache-control':'private, no-store'}}) };
  if(match[3]==='/copy') {
    if(request.method!=='POST') throw new HttpError(405,'Method not allowed');
    assertSameOrigin(request);
    return {request,response:await tenant.copyEnvironment(principal.tenantId,record.id,await readJson(request,4096))};
  }
  if(record.status && record.status!=='ready') return {request,response:Response.json({error:'Environment copy is not ready',environment:record},{status:409,headers:{'cache-control':'private, no-store'}})};
  url.pathname = `/v1/tenants/${principal.tenantId}${match[3] ?? ""}`;
  return { request: new Request(url, request), environmentId: record.id };
}
