import type { TenantDO, TenantEnvironment } from "../../../packages/control-plane/src/object.ts";
import type { EnvironmentRecord } from "../../../packages/control-plane/src/contracts.ts";
import { tenantAddress } from "../../../packages/control-plane/src/object.ts";
import { id } from "../../../packages/control-plane/src/contracts.ts";
import type { Principal } from "../../../packages/tenant/src/index.ts";
import { assertSameOrigin, HttpError, readJson } from "./http.ts";

async function knownEnvironment(tenant: DurableObjectStub<TenantDO>, tenantId: string, environmentId: string): Promise<EnvironmentRecord | undefined> {
  // TenantDO already caches the authoritative catalogue locally. Cross-isolate
  // existence caches cannot safely authorize a paused/deleted environment.
  return tenant.environment(tenantId,environmentId);
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
  if (!match) {
    const legacy=/^\/v1\/tenants\/([^/]+)\//.exec(url.pathname);
    if(legacy){
      if(legacy[1]!==principal.tenantId)throw new HttpError(403,'Tenant access denied');
      const tenant=env.TENANTS.getByName(tenantAddress(principal.tenantId));
      const record=await knownEnvironment(tenant,principal.tenantId,'default');
      if(record?.status && record.status!=='ready')return {request,response:Response.json({error:'默认环境当前不可用',environment:record},{status:409})};
    }
    return {request};
  }
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
  if(!match[3]&&request.method==='DELETE'){
    assertSameOrigin(request);return {request,response:await tenant.lifecycleEnvironment(principal.tenantId,record.id,{action:'delete'})};
  }
  if(record.status==='deleted')return {request,response:Response.json({error:'环境已删除'},{status:410})};
  if(!match[3]&&request.method==='PATCH'){
    assertSameOrigin(request);return {request,response:await tenant.renameEnvironment(principal.tenantId,record.id,await readJson(request,4096))};
  }
  if(match[3]==='/lifecycle'){
    if(request.method!=='POST')throw new HttpError(405,'Method not allowed');
    assertSameOrigin(request);return {request,response:await tenant.lifecycleEnvironment(principal.tenantId,record.id,await readJson(request,4096))};
  }
  if (!match[3] && request.method === "GET")
    return { request, response: Response.json(record,{headers:{'cache-control':'private, no-store'}}) };
  if(match[3]==='/copy') {
    if(request.method!=='POST') throw new HttpError(405,'Method not allowed');
    assertSameOrigin(request);
    return {request,response:await tenant.copyEnvironment(principal.tenantId,record.id,await readJson(request,4096))};
  }
  if(record.status && record.status!=='ready') return {request,response:Response.json({error:'环境当前不可用，请在首页查看状态',environment:record},{status:409,headers:{'cache-control':'private, no-store'}})};
  url.pathname = `/v1/tenants/${principal.tenantId}${match[3] ?? ""}`;
  return { request: new Request(url, request), environmentId: record.id };
}
