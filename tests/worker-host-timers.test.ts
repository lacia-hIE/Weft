import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {DurablePluginTimers} from '../packages/native-plugins/src/durable-timers.ts';
import {pluginFetch} from '../packages/native-plugins/src/network.ts';

test('background timer reconstruction preserves due work, retries failures and resets on new approval', async () => {
  const db = new DatabaseSync(':memory:');
  const storage = {sql: {exec(query: string, ...bindings: (string | number | null)[]) {
    const rows = db.prepare(query).all(...bindings); return {toArray: () => rows, one: () => rows[0]};
  }}, transactionSync: (fn: () => unknown) => fn(), sync: async () => {}} as unknown as DurableObjectStorage;
  try {
    let calls = 0;
    const first = new DurablePluginTimers(storage, 'approved-a'); first.register(() => {calls++;}, 60_000, true);
    db.prepare('UPDATE plugin_timers SET due=1').run();
    const restored = new DurablePluginTimers(storage, 'approved-a'); restored.register(() => {calls++;}, 60_000, true);
    assert.equal(restored.next(), 1);
    await Promise.all([restored.tick(), restored.tick()]); assert.equal(calls, 1);
    assert.ok(restored.next()! > Date.now());
    const retry = new DurablePluginTimers(storage, 'approved-b'); retry.register(() => {throw new Error('temporary');}, 1000, false);
    db.prepare('UPDATE plugin_timers SET due=1').run(); await retry.tick(); assert.ok(retry.next()! > Date.now());
    const switched = new DurablePluginTimers(storage, 'approved-c'); assert.equal(switched.next(), undefined);
    const cancel = switched.register(() => {calls++;}, 1000, false); cancel(); assert.equal(switched.next(), undefined);
    assert.throws(() => switched.register(() => {}, 1, true));
  } finally {db.close();}
});

test('plugin egress checks authorization before touching the network and rejects non-HTTPS/private literals', async () => {
  let checks = 0;
  for (const address of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://service.internal', 'https://example.com:8443']) {
    await assert.rejects(pluginFetch(new Request(address), async () => {checks++;}), /not allowed/);
  }
  assert.equal(checks, 6);
  assert.throws(() => new Request('https://user:secret@example.com'), /credentials/);
  await assert.rejects(pluginFetch(new Request('https://example.com'), async () => {throw new Error('revoked');}), /revoked/);
});

test('plugin egress abort cancels a stalled request body before starting a network request', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({cancel() {cancelled = true;}});
  const request = new Request('https://example.com', {method: 'POST', body, signal: controller.signal, duplex: 'half'} as RequestInit);
  const pending = pluginFetch(request, async () => {});
  // Let the bridge start consuming the body, then interrupt the blocked read.
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(new Error('cancelled by plugin'));
  await assert.rejects(pending, /cancelled by plugin/);
  assert.equal(cancelled, true);
});
