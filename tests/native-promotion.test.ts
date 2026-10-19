import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

test('opening a cold root promotes only the owning native host after its snapshot without creating a model turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-root-promotion-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  const observers: {close(): Promise<void>}[] = [];
  try {
    await api.call('session/create', {request: {sessionId: 'root'}});
    const first = await api.follow('root'); observers.push(first); await first.next();
    await api.call('session/prompt', {request: {sessionId: 'root', requestId: 'first', mode: 'queue', content: [{type: 'text', text: 'A completed turn'}]}});
    for (;;) {const frame = await first.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await first.close(); observers.pop(); await runtime.dispose(); runtime = createRuntime(directory, {browser: true});
    const list = () => api.call<{items: {agentAvailable: boolean}[]}>('session/list', {_request: {}});
    assert.equal((await list()).items[0]!.agentAvailable, false);
    const restored = await api.follow('root'); observers.push(restored);
    const snapshot = await restored.next(); assert.equal(snapshot.type, 'snapshot');
    if (snapshot.type !== 'snapshot') throw Error('Missing cold snapshot');
    const deadline = Date.now() + 15000;
    while (!(await list()).items[0]!.agentAvailable) {
      if (Date.now() >= deadline) throw Error('The owning native host was not promoted');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const active = await api.follow('root'); observers.push(active);
    const next = await active.next(); assert.equal(next.type, 'snapshot');
    if (next.type !== 'snapshot') throw Error('Missing active snapshot');
    assert.ok(next.cursor >= snapshot.cursor);
    assert.deepEqual(next.records.slice(0, snapshot.records.length), snapshot.records);
    assert.doesNotMatch(JSON.stringify(next.records.slice(snapshot.records.length)), /turn\/start|request\/header|assistant\/message|user\/message/, 'activation must not submit a model turn');
  } finally {for (const observer of observers) await observer.close(); await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
