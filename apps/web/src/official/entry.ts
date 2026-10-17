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

function transport(base: string): ClientTransportHooks {
  return {
    fetch: (input, init) => {
      const path = String(input);
      if (!path.startsWith('api/')) throw new Error(`Unsupported Harness RPC channel ${path}`);
      return fetch(`${base}/${path}`, init);
    },
    async *openStream(endpoint, payload, signal, uplink) {
      const abort = new AbortController();
      const combined = AbortSignal.any([signal, abort.signal]);
      const input = uplink?.[Symbol.asyncIterator]();
      let inputFailure: Error | undefined;
      const sending = input ? (async () => {
        for (;;) {
          const item = await input.next();
          if (item.done) return;
          throw new Error('Bidirectional Harness stream messages are not connected yet');
        }
      })().catch(error => { inputFailure = error; abort.abort(error); }) : Promise.resolve();
      try {
      const response = await fetch(`${base}/streams/${endpoint}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload), signal: combined});
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
      finally { abort.abort(); await input?.return?.(); await sending; }
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
