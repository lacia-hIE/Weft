import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('official Goal service, /goal command and activation notifications run on the native root', {timeout: 90_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const events = await api.stream<RemoteEventDownlinkFrame>('$events', {});
  try {
    assert.equal((await events.next()).type, 'ready');
    await api.call('session/create', {request: {sessionId: 'goal'}});
    assert.ok((await api.call<{name: string}[]>('commands/list', {agentId: 'goal'})).some(command => command.name === 'goal'));
    assert.equal(await api.call('goals/get', {agentId: 'goal'}), undefined);

    const created = await api.call<{ref: {id: string; revision: number}}>('goals/create', {agentId: 'goal', request: {objective: 'GOAL_OBJECTIVE_ALPHA', maxGoalRounds: 1}});
    assert.equal(typeof created.ref.id, 'string');
    let frame: RemoteEventDownlinkFrame;
    do frame = await events.next(); while (!(frame.type === 'emit' && frame.event === 'goal/activation-changed'));
    assert.match(JSON.stringify(frame.args), /"sessionId":"goal"/);

    const view = await api.call<{id: string; objective: string; revision: number}>('goals/get', {agentId: 'goal'});
    assert.equal(view.objective, 'GOAL_OBJECTIVE_ALPHA');
    const projections = await api.call<{values: Record<string, unknown>}>('session/projections', {request: {sessionId: 'goal'}});
    assert.match(JSON.stringify(projections.values.goal), /GOAL_OBJECTIVE_ALPHA/, 'the read side folds the original goal projection');
    const stale = await api.raw('goals/clear', {agentId: 'goal', ref: {id: view.id, revision: view.revision + 100}});
    assert.equal(stale.result.ok, false, 'a stale revision is rejected by the service');
    const current = await api.call<{id: string; revision: number}>('goals/get', {agentId: 'goal'});
    await api.call('goals/clear', {agentId: 'goal', ref: {id: current.id, revision: current.revision}});
    assert.equal(await api.call('goals/get', {agentId: 'goal'}), undefined);
    assert.equal((await api.raw('goals/get', {agentId: 'missing'})).result.error?.code, 'session/not-found');
  } finally {
    await events.close();
    await runtime.dispose();
  }
});
