import type { TenantEnvironment } from "../../../packages/control-plane/src/object.ts";
import { tenantAddress } from "../../../packages/control-plane/src/object.ts";
import { id } from "../../../packages/control-plane/src/contracts.ts";
import type { Principal } from "../../../packages/tenant/src/index.ts";
import { assertSameOrigin, HttpError, readJson } from "./http.ts";

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
          await readJson(request, 4096),
        ),
      };
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (!id.safeParse(match[2]).success)
    throw new HttpError(400, "Invalid environment identity");
  const record = await tenant.environment(principal.tenantId, match[2]);
  if (!record) throw new HttpError(404, "Environment not found");
  if (!match[3] && request.method === "GET")
    return { request, response: Response.json(record) };
  url.pathname = `/v1/tenants/${principal.tenantId}${match[3] ?? ""}`;
  return { request: new Request(url, request), environmentId: record.id };
}
