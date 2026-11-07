import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout} from 'node:timers/promises';
import type {SessionCreateValue, SessionFollowFrame} from '@deepseek-ai/dsh-api-session-controller/types';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {sessionAddress} from '../packages/tenant/src/index.ts';
import {DATA_LAYOUT_VERSION} from '../packages/tenant/src/layout.ts';

test('native passive WebSockets deliver live journals and restore a fresh generation after actual workerd hibernation', {timeout: 120_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  const sockets: {close(): void}[] = [];
  const open = async (endpoint: string, args: unknown) => {
    const query = new URLSearchParams({payload: JSON.stringify({args})});
    const response = await runtime.dispatchFetch(url('alpha', `${base}/sockets/${endpoint}?${query}`), {headers: {upgrade: 'websocket'}});
    assert.equal(response.status, 101, response.status === 101 ? '' : await response.text());
    const socket = response.webSocket!;
    sockets.push(socket);
    const items: unknown[] = [];
    let notify: (() => void) | undefined;
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => {resolve(event.code); notify?.();}));
    socket.addEventListener('message', event => {items.push(JSON.parse(String(event.data))); notify?.();});
    socket.accept();
    return {
      closed,
      close: () => socket.close(),
      async next<T>(): Promise<T> {
        while (!items.length) await new Promise<void>(resolve => {notify = resolve;});
        notify = undefined;
        const value = items.shift() as {type: string; value: T};
        assert.equal(value.type, 'item', JSON.stringify(value));
        return value.value;
      },
    };
  };
  try {
    const {sessionId} = await api.call<SessionCreateValue>('session/create', {request: {sessionId: 'hibernation'}});
    const args = {request: {address: {kind: 'session', sessionId}, assistantStream: true}};
    const follow = await open('session/follow', args);
    assert.equal((await follow.next<SessionFollowFrame>()).type, 'snapshot');
    await api.call('session/rename', {request: {sessionId, title: 'Before hibernation'}});
    const changed = await follow.next<SessionFollowFrame>();
    assert.notEqual(changed.type, 'snapshot', 'a live physical generation has only one opening snapshot');
    assert.match(JSON.stringify(changed), /Before hibernation/);

    // No polling or HTTP follow is allowed to keep this object resident.
    // workerd naturally evicts an idle object after ten seconds.
    await setTimeout(15_000);
    await api.call('session/rename', {request: {sessionId, title: 'After hibernation'}});
    assert.equal(await follow.closed, 1012, 'evicted native iterators request original Client generation recovery');
    const restored = await open('session/follow', args);
    const snapshot = await restored.next<SessionFollowFrame>();
    assert.equal(snapshot.type, 'snapshot');
    assert.match(JSON.stringify(snapshot), /After hibernation/);
    assert.doesNotMatch(JSON.stringify(snapshot), /interrupted/, 'a passive observer never synthesizes an interrupted turn');

    const events = await open('$events', {});
    const ready = await events.next<{type: string; clientId: string}>();
    assert.equal(ready.type, 'ready');
    for (const endpoint of ['session/control', 'workspace/follow', 'remoteAccess/follow']) {
      const feed = await open(endpoint, {});
      assert.equal((await feed.next<{type: string}>()).type, 'baseline');
    }
    await runtime.unsafeEvictDurableObject('alpha', 'EnvironmentDO', {name: JSON.stringify([DATA_LAYOUT_VERSION, 'environment', tenantId('alpha'), 'default']), webSockets: 'hibernate'});
    await api.call('session/list', {_request: {}});
    assert.equal(await events.closed, 1012);
    const nextEvents = await open('$events', {});
    assert.notEqual((await nextEvents.next<{clientId: string}>()).clientId, ready.clientId);
  } finally {for (const socket of sockets) socket.close(); await runtime.dispose();}
});

test('passive socket upgrades preserve owner, origin, endpoint and paused-environment boundaries', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const path = base+'/native/sockets/$events?'+new URLSearchParams({payload: '{"args":{}}'});
  try {
    await api.call('session/list', {_request: {}});
    assert.equal((await runtime.dispatchFetch(url('beta', path), {headers: {upgrade: 'websocket'}})).status, 403);
    assert.equal((await runtime.dispatchFetch(url('alpha', path), {headers: {upgrade: 'websocket', origin: 'https://untrusted.test'}})).status, 403);
    assert.equal((await runtime.dispatchFetch(url('alpha', path))).status, 426);
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/native/sockets/shell/attach?payload=%7B%7D'), {headers: {upgrade: 'websocket'}})).status, 404);
    const response = await runtime.dispatchFetch(url('alpha', path), {headers: {upgrade: 'websocket'}});
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve()));
    socket.accept();
    const pause = await runtime.dispatchFetch(url('alpha', base+'/lifecycle'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'suspend'})});
    assert.equal(pause.status, 202);
    await closed;
    assert.equal((await runtime.dispatchFetch(url('alpha', path), {headers: {upgrade: 'websocket'}})).status, 409);
  } finally {await runtime.dispose();}
});
