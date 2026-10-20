import { uiPaths, uiRevisions } from "../../../.generated/ui-paths.ts";
const paths = new Set(uiPaths);
export function serveUi(
  request: Request,
  assets: Fetcher,
): Promise<Response> | undefined {
  const url = new URL(request.url);
  const environmentDocument = /^\/agents\/[a-zA-Z0-9_-]{1,80}\/?$/.test(url.pathname);
  const officialDocument = environmentDocument;
  // Content-addressed responses may live in the browser cache: boot graph modules
  // requested at their current revision, and esbuild's hashed chunks.
  let immutable = /^\/assets\/(?:chunk|entry)-[A-Z0-9]{8}\.js$/.test(url.pathname);
  if (url.pathname === '/harness/' && url.search.startsWith('??')) {
    const match = /^\?\?(@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)\/client\.js&rev=([a-f0-9]+)$/.exec(url.search);
    if (!match) return undefined;
    url.pathname = `/harness/${match[1]}/client.js`;
    url.search = '';
    immutable = uiRevisions[url.pathname] === match[2];
  }
  if (environmentDocument) url.pathname = "/";
  if (["GET", "HEAD"].includes(request.method) && url.pathname.startsWith('/assets/') && !paths.has(url.pathname)) {
    return Promise.resolve(new Response('Not found', {status: 404, headers: {'cache-control': 'private, no-store'}}));
  }
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !paths.has(url.pathname)
  )
    return undefined;
  return assets.fetch(new Request(url, { method: request.method, headers: {...(officialDocument ? {'x-weft-harness-document': 'official'} : {}), ...(immutable ? {'x-weft-immutable': '1'} : {})} }));
}
