import { uiPaths } from "../../../.generated/ui-paths.ts";
const paths = new Set(uiPaths);
export function serveUi(
  request: Request,
  assets: Fetcher,
): Promise<Response> | undefined {
  const url = new URL(request.url);
  if (/^\/agents\/[a-zA-Z0-9_-]{1,80}\/?$/.test(url.pathname)) url.pathname = "/";
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !paths.has(url.pathname)
  )
    return undefined;
  return assets.fetch(new Request(url, { method: request.method }));
}
