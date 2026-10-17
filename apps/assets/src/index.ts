// Private service Worker. Only the authenticated public Worker can call it;
// Static Assets routing never participates in the public ctx.access boundary.
export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Not found", {status: 404});
    const url = new URL(request.url);
    if (url.pathname === "/") url.pathname = "/index.html";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set("referrer-policy", "same-origin");
    return new Response(asset.body, {status: asset.status, headers});
  },
} satisfies ExportedHandler<{ASSETS: Fetcher}>;
