import assert from 'node:assert/strict';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime, tenantId, url, type User } from './miniflare.ts';

type Runtime = ReturnType<typeof createRuntime>;
export function nativeClient(runtime: () => Runtime, environment = 'default', user: User = 'alpha', jsonHeaders: Record<string, string> = {}) {
  const base = `/v1/tenants/${tenantId(user)}/environments/${environment}/native`;
  return {
    async raw(endpoint: string, args: unknown, method = endpoint) {
      const response = await runtime().dispatchFetch(url(user, `${base}/api/${endpoint}`), {
        method: 'POST', headers: {...jsonHeaders, 'content-type': 'application/json'},
        body: JSON.stringify({type: 'client-request', rpcId: 'fixture-rpc', method, payload: {args}}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      return await response.json() as {rpcId: string; result: {ok: boolean; value: unknown; error?: {code: string; details?: Record<string, unknown>}}};
    },
    async call<T>(endpoint: string, args: unknown): Promise<T> {
      const body = await this.raw(endpoint, args);
      assert.equal(body.result.ok, true, JSON.stringify(body));
      assert.equal(body.rpcId, 'fixture-rpc');
      return body.result.value as T;
    },
    async stream<T>(endpoint: string, args: unknown) {
      const abort = new AbortController();
      const observerId = endpoint === 'workspaceFiles/changes' ? crypto.randomUUID() : undefined;
      const response = await runtime().dispatchFetch(url(user, `${base}/streams/${endpoint}`), {
        method: 'POST', headers: {'content-type': 'application/json', ...(observerId ? {'x-weft-observer-id': observerId} : {})},
        body: JSON.stringify({args}), signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      return {
        observerId,
        async next(): Promise<T> {
          for (;;) {
            const end = pending.indexOf('\n\n');
            if (end >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
              assert.ok(data, frame);
              assert.ok(frame.startsWith('event: item'), data);
              return JSON.parse(data) as T;
            }
            const part = await reader.read();
            assert.equal(part.done, false, 'follow ended before the expected frame');
            pending += decoder.decode(part.value, {stream: true});
          }
        },
        close: async () => {
          if (observerId) {
            const sessionId = (args as {workspaceFileScopeId: string}).workspaceFileScopeId;
            const response = await runtime().dispatchFetch(url(user, base+'/file-observers/cancel'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId, observerId})});
            assert.equal(response.status, 204);
          }
          abort.abort();
          try {await reader.cancel();}
          catch (error) {if (error !== abort.signal.reason) throw error;}
        },
      };
    },
    follow(sessionId: string) {
      return this.stream<SessionFollowFrame>('session/follow', {request: {address: {kind: 'session', sessionId}, assistantStream: true}});
    },
    events() { return this.stream<RemoteEventDownlinkFrame>('$events', {}); },
  };
}
