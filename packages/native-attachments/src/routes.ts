import {Service, type Context} from '@deepseek-ai/cordis';
import type {ConnectionFetchRoute} from '@weft/upstream/packages/client/connection/src/rpc.ts';

/** Exact native fetch routes, dispatched only after Access and addressed DO scope validation. */
export class AuthenticatedFetchRoutes extends Service {
  private readonly routes = new Map<string, ConnectionFetchRoute>();
  constructor(ctx: Context) {super(ctx, 'weftConnectionRoutes');}
  register(route: ConnectionFetchRoute): () => Promise<void> {
    if (!route.path.startsWith('/api/') || this.routes.has(route.path)) throw new Error('Invalid or duplicate native Fetch route');
    this.routes.set(route.path, route);
    return async () => {if (this.routes.get(route.path) === route) this.routes.delete(route.path);};
  }
  async dispatch(request: Request): Promise<Response> {
    const route = this.routes.get(new URL(request.url).pathname);
    if (!route) return new Response('Native Fetch route not found', {status: 404});
    return route.fetch(request);
  }
}
