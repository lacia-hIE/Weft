interface Route {
  kind: 'exact' | 'prefix'; path: string;
  resource?: (request: Request) => Promise<Response>;
  handler?: (request: unknown, response: unknown) => unknown;
}
const MAX_BYTES = 1_048_576;
/** A Worker HTTP carrier for named native routes; no listener or process is created. */
export class WorkerWebServer {
  private readonly routes = new Map<string, Route>();
  private origin: string | undefined;
  register(route: Route): () => void {
    if (!route || !['exact', 'prefix'].includes(route.kind) || !/^\/[a-zA-Z0-9/_-]+$/.test(route.path) || route.path.endsWith('/') || route.path.includes('//') || this.routes.has(route.path)
      || typeof route.handler !== 'function' && typeof route.resource !== 'function' || this.routes.size >= 32) throw new Error('Invalid, duplicate or excessive plugin HTTP route');
    this.routes.set(route.path, route);
    return () => {if (this.routes.get(route.path) === route) this.routes.delete(route.path);};
  }
  getOrigin(): string {if (!this.origin) throw new Error('A Worker route has no listening origin before its first request'); return this.origin;}
  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url); this.origin = url.origin;
    const route = this.routes.get(url.pathname) ?? [...this.routes.values()].filter(row => row.kind === 'prefix' && url.pathname.startsWith(row.path + '/')).sort((a,b) => b.path.length - a.path.length)[0];
    if (!route) return new Response(null, {status: 404});
    if (route.resource) {
      if (!['GET','HEAD'].includes(request.method)) return new Response(null, {status:405,headers:{allow:'GET, HEAD'}});
      const response = await route.resource(request);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }
    const parts: Uint8Array[] = []; let size = 0, status = 200, ended = false;
    const headers = new Headers();
    const encode = (value: unknown) => typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : undefined;
    const write = (value: unknown) => {
      if (ended) throw new Error('HTTP response already ended');
      const bytes = encode(value); if (!bytes) throw new Error('Plugin HTTP responses require text or bytes');
      size += bytes.length; if (size > MAX_BYTES) throw new Error('Plugin HTTP response exceeds 1 MiB'); parts.push(bytes); return true;
    };
    const response = {
      get statusCode() {return status;}, set statusCode(value: number) {status = value;},
      get headersSent() {return ended;}, get writableEnded() {return ended;},
      setHeader(name: string, value: string | number) {headers.set(name, String(value));return response;},
      getHeader(name: string) {return headers.get(name) ?? undefined;},
      writeHead(code: number, values?: Record<string,string>) {status=code; for(const [key,value] of Object.entries(values ?? {}))headers.set(key,value);return response;},
      write, end(value?: unknown) {if(value !== undefined)write(value);ended=true;return response;},
    };
    const incoming = {method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers),
      async *[Symbol.asyncIterator]() {
        if (!request.body) return;
        const reader = request.body.getReader(); let read = 0;
        try {for (;;) {const part = await reader.read(); if(part.done)return; read += part.value.length; if(read>65536)throw new Error('Plugin HTTP request exceeds 64 KiB'); yield part.value;}}
        finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      },
    };
    await route.handler!(incoming,response);
    if (!ended) throw new Error('Plugin HTTP handler must end its response; socket and SSE APIs are not bridged');
    const bytes = new Uint8Array(size); let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return new Response(request.method === 'HEAD' || [204,205,304].includes(status) ? null : bytes,{status,headers});
  }
}
