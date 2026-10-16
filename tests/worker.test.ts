import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime, users, tenantId, url, sessionPath, send, type EventRecord, type SessionResponse } from './helpers/miniflare.ts';

function assertContinuous(events: EventRecord[]): void {
  assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index));
}

test('upstream AgentLoop runs two model steps and a real registered tool inside workerd', async () => {
  const runtime = createRuntime();
  try {
    const response = await send(runtime, 'alpha', 'loop', 'Use your identity tool');
    assert.equal(response.status, 200, await response.clone().text());
    const { events } = await response.json() as SessionResponse;
    assertContinuous(events);
    assert.equal(events.filter(event => event.type === 'step/start').length, 2);
    assert.equal(events.filter(event => event.type === 'tool/call').length, 1);
    const result = events.find(event => event.type === 'tool/result');
    assert.deepEqual(result?.data.message?.content, [{ type: 'text', text: tenantId('alpha') }]);
    assert.equal(events.at(-1)?.type, 'turn/end');
    assert.equal(events.at(-1)?.data.reason?.kind, 'completed');
    const reply = events.findLast(event => event.type === 'assistant/message');
    assert.deepEqual(reply?.data.message?.content, [{ type: 'text', text: `Tenant: ${tenantId('alpha')}` }]);
  } finally { await runtime.dispose(); }
});

test('tenants using the same session id retain separate prompts, logs and tool identities', async () => {
  const runtime = createRuntime();
  try {
    const responses = await Promise.all([
      send(runtime, 'alpha', 'shared-id', 'alpha private input'),
      send(runtime, 'beta', 'shared-id', 'beta private input'),
    ]);
    const bodies = await Promise.all(responses.map(async response => {
      assert.equal(response.status, 200);
      return response.text();
    }));
    assert.ok(bodies[0]!.includes(`assistant for tenant ${tenantId('alpha')}`));
    assert.match(bodies[0]!, /alpha private input/);
    assert.doesNotMatch(bodies[0]!, /beta private input/);
    assert.ok(!bodies[0]!.includes(tenantId('beta')));
    assert.ok(bodies[1]!.includes(`assistant for tenant ${tenantId('beta')}`));
    assert.doesNotMatch(bodies[1]!, /alpha private input/);
    assert.ok(!bodies[1]!.includes(tenantId('alpha')));
    for (const user of Object.values(users)) for (const body of bodies) assert.ok(!body.includes(user.email));
  } finally { await runtime.dispose(); }
});

test('only trusted Access users of this application can reach sessions', async () => {
  const runtime = createRuntime();
  try {
    for (const profile of ['anonymous', 'wrong-app', 'service', 'no-user-id']) {
      const response = await runtime.dispatchFetch(url(profile, sessionPath('alpha', 'x', 'events')), {
        headers: { authorization: 'Bearer validation-alpha-token', 'cf-access-authenticated-user-email': users.alpha.email,
          'cf-access-jwt-assertion': 'forged', 'x-tenant-id': tenantId('alpha') },
      });
      assert.equal(response.status, 401, profile);
      assert.equal((await runtime.dispatchFetch(url(profile, '/health'))).status, 401);
    }
    assert.equal((await send(runtime, 'beta', 'x', 'attempt', 'alpha')).status, 403);
    const read = await runtime.dispatchFetch(url('alpha', sessionPath('beta', 'x', 'events')));
    assert.equal(read.status, 403);
    const missing = await runtime.dispatchFetch(url('beta', sessionPath('beta', 'x', 'events')));
    assert.equal(missing.status, 404);
  } finally { await runtime.dispose(); }
});

test('identity discovery stays stable across email changes and accepts runtime subject claims', async () => {
  const runtime = createRuntime();
  try {
    for (const profile of ['alpha', 'renamed', 'claims']) {
      const response = await runtime.dispatchFetch(url(profile, '/v1/me'));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const body = await response.json() as { tenantId: string; user: { id: string; email: string } };
      assert.equal(body.tenantId, tenantId('alpha'));
      assert.equal(body.user.id, users.alpha.user_uuid);
      assert.equal(body.user.email, profile === 'renamed' ? 'renamed@example.com' : users.alpha.email);
    }
  } finally { await runtime.dispose(); }
});

test('cookie-authenticated writes reject cross-origin requests', async () => {
  const runtime = createRuntime();
  try {
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'csrf', 'messages')), {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'attack' }),
      });
      assert.equal(response.status, 403);
    }
    assert.equal((await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'csrf', 'events')))).status, 404);
    const allowed = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'csrf', 'messages')), {
      method: 'POST', headers: { origin: 'http://alpha.local', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'safe' }),
    });
    assert.equal(allowed.status, 200);
  } finally { await runtime.dispose(); }
});

test('invalid input and attempted tenant overrides do not enter Harness history', async () => {
  const runtime = createRuntime();
  try {
    for (const body of ['{', JSON.stringify({ text: 'x', tenantId: 'beta' }), JSON.stringify({ text: '' })]) {
      const response = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'input', 'messages')), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      assert.equal(response.status, 400);
    }
    const oversized = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'input', 'messages')), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(20_000) }),
    });
    assert.equal(oversized.status, 413);
    const events = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'input', 'events')));
    assert.equal(events.status, 404);
  } finally { await runtime.dispose(); }
});

test('concurrent sends to one session complete as separate ordered turns', async () => {
  const runtime = createRuntime();
  try {
    const responses = await Promise.all([
      send(runtime, 'alpha', 'concurrent', 'first input'),
      send(runtime, 'alpha', 'concurrent', 'second input'),
    ]);
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    const read = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'concurrent', 'events')));
    const { events } = await read.json() as SessionResponse;
    assertContinuous(events);
    assert.deepEqual(events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2]);
    assert.equal(events.filter(event => event.type === 'turn/end').length, 2);
    const firstEnd = events.findIndex(event => event.type === 'turn/end');
    const secondStart = events.findLastIndex(event => event.type === 'turn/start');
    assert.ok(firstEnd < secondStart);
  } finally { await runtime.dispose(); }
});

test('a new workerd process reads persisted events and resumes the original session', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'weft-sessions-'));
  let runtime = createRuntime(persist);
  try {
    const initial = await send(runtime, 'alpha', 'restart', 'before restart');
    assert.equal(initial.status, 200);
    const before = await initial.json() as SessionResponse;
    await runtime.dispose();
    runtime = createRuntime(persist);
    const read = await runtime.dispatchFetch(url('alpha', sessionPath('alpha', 'restart', 'events')));
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as SessionResponse).events, before.events);
    const continued = await send(runtime, 'alpha', 'restart', 'after restart');
    assert.equal(continued.status, 200, await continued.clone().text());
    const after = await continued.json() as SessionResponse;
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    assertContinuous(after.events);
    assert.deepEqual(after.events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2]);
  } finally {
    await runtime.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
