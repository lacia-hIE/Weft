import { AppWebEntry } from '@deepseek-ai/dsh-client-web';
import * as modules from '@deepseek-ai/dsh-client-modules/client';
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client';
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client';
import { createParser } from 'eventsource-parser';
import { z } from 'zod';
import { installEnvironmentStorage } from './storage.ts';
import '@weft/upstream/packages/client/ui-theme/src/styles/brand-font.css';

const failure = z.object({code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown())});
function wireError(value: unknown): Error {
  const error = failure.parse(value);
  // Native Remote errors use structural identity across module/realm copies.
  return Object.assign(new Error(error.message), error, {isDSHRemoteError: true as const});
}

const ordered = z.object({payload: z.object({args: z.object({agentId: z.string().optional(), request: z.object({sessionId: z.string()}).partial().optional()}).loose()}).loose()}).loose();
/** The Session that an ordered call targets, read from its JSON-RPC body. */
function orderedSession(init: RequestInit | undefined): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  const {args} = ordered.parse(JSON.parse(init.body)).payload;
  return args.agentId ?? args.request?.sessionId;
}

function transport(base: string): ClientTransportHooks {
  // The original Host reads one ordered socket, so a preset selection sent
  // before a prompt commits first; separate HTTP requests keep that order here.
  const selecting = new Map<string, Promise<unknown>>();
  return {
    fetch: async (input, init) => {
      const path = String(input);
      if (!path.startsWith('api/')) throw new Error(`Unsupported Harness RPC channel ${path}`);
      const session = path === 'api/agentPresets/select' || path === 'api/session/prompt' ? orderedSession(init) : undefined;
      if (session === undefined) return fetch(`${base}/${path}`, init);
      if (path === 'api/session/prompt') {
        await selecting.get(session);
        return fetch(`${base}/${path}`, init);
      }
      const response = fetch(`${base}/${path}`, init);
      const settled = response.then(() => undefined, () => undefined);
      selecting.set(session, settled);
      void settled.then(() => {if (selecting.get(session) === settled) selecting.delete(session);});
      return response;
    },
    async *openStream(endpoint, payload, signal, uplink) {
      const observer = endpoint === 'workspaceFiles/changes' ? {
        observerId: crypto.randomUUID(),
        sessionId: z.object({args: z.object({workspaceFileScopeId: z.string()})}).parse(payload).args.workspaceFileScopeId,
      } : undefined;
      const abort = new AbortController();
      const combined = AbortSignal.any([signal, abort.signal]);
      const input = uplink?.[Symbol.asyncIterator]();
      const streamId = input ? crypto.randomUUID() : undefined;
      let inputFailure: Error | undefined;
      // Client messages of a bidirectional stream travel as ordered RPCs addressed to the stream's owner.
      const send = async (items: unknown[], end: boolean) => {
        const args = z.object({args: z.unknown()}).parse(payload).args;
        const response = await fetch(`${base}/api/$stream/input`, {method: 'POST', headers: {'content-type': 'application/json'}, signal: combined,
          body: JSON.stringify({type: 'client-request', rpcId: crypto.randomUUID(), method: '$stream/input', payload: {args: {streamId, endpoint, args, items, end}}})});
        const envelope = z.object({result: z.union([z.object({ok: z.literal(true)}).passthrough(), z.object({ok: z.literal(false), error: failure})])}).parse(await response.json());
        if (!envelope.result.ok) throw wireError((envelope.result as {error: unknown}).error);
      };
      const sending = input ? (async () => {
        for (;;) {
          const item = await input.next();
          if (item.done) {await send([], true); return;}
          await send([item.value], false);
        }
      })().catch(error => { if (!combined.aborted) {inputFailure = error; abort.abort(error);} }) : Promise.resolve();
      try {
      const response = await fetch(`${base}/streams/${endpoint}`, {method: 'POST', headers: {'content-type': 'application/json', ...(observer ? {'x-weft-observer-id': observer.observerId} : {}), ...(streamId ? {'x-weft-stream-id': streamId} : {})}, body: JSON.stringify(payload), signal: combined});
      if (!response.ok) throw new Error(`Harness stream HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
        const body: unknown = await response.json();
        const envelope = z.object({result: z.object({ok: z.literal(false), error: failure})}).parse(body);
        throw wireError(envelope.result.error);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const pending: unknown[] = [];
      let error: Error | undefined;
      const parser = createParser({onEvent: event => {
        if (event.event === 'item') pending.push(JSON.parse(event.data));
        else if (event.event === 'error') error = wireError(JSON.parse(event.data));
      }});
      try {
        for (;;) {
          while (pending.length) yield pending.shift();
          if (error) throw error;
          const chunk = await reader.read();
          combined.throwIfAborted();
          if (chunk.done) break;
          parser.feed(decoder.decode(chunk.value, {stream: true}));
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      } catch (error) { throw inputFailure ?? error; }
      finally {
        abort.abort();
        if (observer) await fetch(`${base}/file-observers/cancel`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(observer), keepalive: true}).catch(() => {});
        await input?.return?.(); await sending;
      }
    },
  };
}

/** The unmodified official boot kernel owns every entry, slot and rendered page. */
export async function startOfficialHarness(environmentId: string): Promise<void> {
  const meResponse = await fetch('/v1/me');
  if (!meResponse.ok) throw new Error('请先通过 Cloudflare Access 登录');
  const me = z.object({tenantId: z.string()}).parse(await meResponse.json());
  const base = `/v1/tenants/${encodeURIComponent(me.tenantId)}/environments/${encodeURIComponent(environmentId)}`;
  const environment = await fetch(base);
  if (!environment.ok) throw new Error('Harness 环境不存在或无权访问');
  const record=z.object({kind:z.string().optional()}).parse(await environment.json());
  if(record.kind==='local'){location.replace(`${base}/local/web/`);return;}
  installEnvironmentStorage(me.tenantId, environmentId);
  // Native auxiliary HTTP routes are document-relative, alongside the Remote
  // transport. Give uploads, exports and capability probes the same owner scope.
  const mount = document.createElement('base');
  mount.href = `${base}/native/`;
  document.head.insertBefore(mount, document.head.firstChild);
  const graphResponse = await fetch('/harness/boot.json');
  if (!graphResponse.ok) throw new Error('官方 Harness 构建产物未准备好');
  const graph: unknown = await graphResponse.json();
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [],
    load(registration) { target.pendingQueue.push(registration); },
    create(options) { return modules.createClientModuleSystem(target, {id: '@deepseek-ai/dsh-client-modules', exports: modules}, options); },
  };
  const page = globalThis as typeof globalThis & {
    __ModuleLoader__?: ClientModuleLoaderTarget;
    __DSH_BOOT__?: unknown;
    __DSH_TRANSPORT__?: ClientTransportHooks;
  };
  page.__ModuleLoader__ = target;
  page.__DSH_BOOT__ = graph;
  page.__DSH_TRANSPORT__ = transport(`${base}/native`);
  const container = document.getElementById('root')!;
  container.replaceChildren();
  const entry = new AppWebEntry(container);
  window.addEventListener('pagehide', () => { void entry.dispose(); }, {once: true});
  await entry.run();
}
