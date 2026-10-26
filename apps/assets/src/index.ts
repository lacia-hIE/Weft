// Private service Worker. Only the authenticated public Worker can call it;
// Static Assets routing never participates in the public ctx.access boundary.
export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Not found", {status: 404});
    const url = new URL(request.url);
    const official = ['/', '/index.html'].includes(url.pathname) && request.headers.get('x-weft-harness-document') === 'official';
    if (official) url.pathname = "/harness-shell.html";
    else if (url.pathname === "/") url.pathname = "/index.html";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    // Only the public Worker marks a response immutable, after matching its content revision.
    headers.set("cache-control", asset.ok && request.headers.get("x-weft-immutable") === "1" ? "private, max-age=31536000, immutable" : "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    // Official Cordis Loader expressions and the client runner use Function.
    // The public Worker supplies this marker only for the native environment document.
    // Cloudflare Web Analytics injects its beacon into zone pages; it loads from and reports to Cloudflare Insights.
    headers.set("content-security-policy", `default-src 'self'; script-src 'self'${official ? " 'unsafe-eval'" : ''} https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cloudflareinsights.com; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri ${official ? "'self'" : "'none'"}; frame-ancestors 'none'; form-action 'self'`);
    headers.set("referrer-policy", "same-origin");
    return new Response(asset.body, {status: asset.status, headers});
  },
} satisfies ExportedHandler<{ASSETS: Fetcher}>;
