import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const credentials = [
  { token: 'validation-alpha-token', tenantId: 'alpha', persona: 'Alpha private instructions' },
  { token: 'validation-beta-token', tenantId: 'beta', persona: 'Beta private instructions' },
];

export function createRuntime(persist?: string): Miniflare {
  const options = convertV4MiniflareOptions({
    name: 'weft-validation',
    modules: true,
    scriptPath: resolve('dist/worker.js'),
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SESSIONS: { className: 'SessionDO', useSQLite: true } },
    bindings: { VALIDATION_AUTH_JSON: JSON.stringify(credentials) },
  });
  options.workers[0]!.dev = { ...options.workers[0]!.dev, unsafeRegisterWorker: false };
  return new Miniflare({ ...options, ...(persist ? { resourcePersistencePath: persist } : {}) });
}

export function send(runtime: Miniflare, tenantId: string, sessionId: string, text: string, token?: string) {
  return runtime.dispatchFetch(`http://localhost/v1/tenants/${tenantId}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? credentials.find(entry => entry.tenantId === tenantId)!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export interface EventRecord {
  type: string;
  seq: number;
  data: { turn?: number; step?: number; reason?: { kind: string }; message?: { content: { type: string; text?: string }[] }; content?: { type: string; text?: string }[] };
}

export interface SessionResponse { tenantId: string; sessionId: string; events: EventRecord[] }
