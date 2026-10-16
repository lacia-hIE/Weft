import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime, credentials, send, type EventRecord, type SessionResponse } from './helpers/miniflare.ts';

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
    assert.deepEqual(result?.data.message?.content, [{ type: 'text', text: 'alpha' }]);
    assert.equal(events.at(-1)?.type, 'turn/end');
    assert.equal(events.at(-1)?.data.reason?.kind, 'completed');
    const reply = events.findLast(event => event.type === 'assistant/message');
    assert.deepEqual(reply?.data.message?.content, [{ type: 'text', text: 'Tenant: alpha' }]);
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
    assert.match(bodies[0]!, /Alpha private instructions/);
    assert.match(bodies[0]!, /alpha private input/);
    assert.doesNotMatch(bodies[0]!, /Beta private instructions|beta private input|Tenant: beta/);
    assert.match(bodies[1]!, /Beta private instructions/);
    assert.doesNotMatch(bodies[1]!, /Alpha private instructions|alpha private input|Tenant: alpha/);
    for (const credential of credentials) for (const body of bodies) assert.ok(!body.includes(credential.token));
  } finally { await runtime.dispose(); }
});

test('unauthenticated and cross-tenant requests are rejected before session access', async () => {
  const runtime = createRuntime();
  try {
    const noAuth = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/x/events');
    assert.equal(noAuth.status, 401);
    assert.equal((await send(runtime, 'beta', 'x', 'attempt', credentials[0]!.token)).status, 403);
    const read = await runtime.dispatchFetch('http://localhost/v1/tenants/beta/sessions/x/events', {
      headers: { authorization: `Bearer ${credentials[0]!.token}`, 'x-tenant-id': 'beta' },
    });
    assert.equal(read.status, 403);
    const missing = await runtime.dispatchFetch('http://localhost/v1/tenants/beta/sessions/x/events', {
      headers: { authorization: `Bearer ${credentials[1]!.token}` },
    });
    assert.equal(missing.status, 404);
  } finally { await runtime.dispose(); }
});

test('invalid input and attempted tenant overrides do not enter Harness history', async () => {
  const runtime = createRuntime();
  try {
    for (const body of ['{', JSON.stringify({ text: 'x', tenantId: 'beta' }), JSON.stringify({ text: '' })]) {
      const response = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/input/messages', {
        method: 'POST', headers: { authorization: `Bearer ${credentials[0]!.token}`, 'content-type': 'application/json' }, body,
      });
      assert.equal(response.status, 400);
    }
    const oversized = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/input/messages', {
      method: 'POST', headers: { authorization: `Bearer ${credentials[0]!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(20_000) }),
    });
    assert.equal(oversized.status, 413);
    const events = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/input/events', {
      headers: { authorization: `Bearer ${credentials[0]!.token}` },
    });
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
    const read = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/concurrent/events', {
      headers: { authorization: `Bearer ${credentials[0]!.token}` },
    });
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
    const read = await runtime.dispatchFetch('http://localhost/v1/tenants/alpha/sessions/restart/events', {
      headers: { authorization: `Bearer ${credentials[0]!.token}` },
    });
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
