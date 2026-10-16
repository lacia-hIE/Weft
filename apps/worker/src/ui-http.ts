import { uiPaths } from "../../../.generated/ui-paths.ts";
const paths = new Set(uiPaths);
export function serveUi(
  request: Request,
  assets: Fetcher,
): Promise<Response> | undefined {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !paths.has(new URL(request.url).pathname)
  )
    return undefined;
  return assets.fetch(new Request(request.url, { method: request.method }));
}
