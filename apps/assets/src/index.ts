import { uiAssets } from "../../../.generated/ui-assets.ts";

// Private service Worker: no routes, workers.dev/previews or tenant/model
// bindings. The public entry authenticates ctx.access before calling it.
export default {
  fetch(request: Request): Response {
    const asset = uiAssets[new URL(request.url).pathname];
    if (!asset || !["GET", "HEAD"].includes(request.method))
      return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: {
        "content-type": asset.type,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "referrer-policy": "same-origin",
      },
    });
  },
} satisfies ExportedHandler;
