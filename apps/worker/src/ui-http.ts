import { uiPaths } from "../../../.generated/ui-paths.ts";
const paths = new Set(uiPaths);
export function serveUi(
  request: Request,
  assets: Fetcher,
): Promise<Response> | undefined {
  const url = new URL(request.url);
  const environmentDocument = /^\/agents\/[a-zA-Z0-9_-]{1,80}\/?$/.test(url.pathname);
  const officialDocument = environmentDocument && url.searchParams.get('ui') !== 'transition';
  if (url.pathname === '/harness/' && url.search.startsWith('??')) {
    const match = /^\?\?(@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)\/client\.js&rev=[a-f0-9]+$/.exec(url.search);
    if (!match) return undefined;
    url.pathname = `/harness/${match[1]}/client.js`;
    url.search = '';
  }
  if (environmentDocument) url.pathname = "/";
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !paths.has(url.pathname)
  )
    return undefined;
  return assets.fetch(new Request(url, { method: request.method, ...(officialDocument ? {headers: {'x-weft-harness-document': 'official'}} : {}) }));
}
