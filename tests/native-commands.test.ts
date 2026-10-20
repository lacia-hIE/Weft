import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionPage } from '@deepseek-ai/dsh-api-session-controller/types';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('official commands list preset contributions and log /compact through the native Agent across restart', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-native-commands-'));
  let runtime = createRuntime(directory, {browser: true});
  const api = nativeClient(() => runtime);
  try {
    await api.call('session/create', {request: {sessionId: 'commands'}});
    const listed = await api.call<{name: string}[]>('commands/list', {agentId: 'commands'});
    for (const name of ['compact', 'plan']) assert.ok(listed.some(command => command.name === name), JSON.stringify(listed));

    assert.equal(await api.call('commands/execute', {agentId: 'commands', line: '/missing', submittedAttachments: []}), undefined, 'unknown names log nothing');
    const executed = await api.call<{commandId: string; result: {kind: string}}>('commands/execute', {agentId: 'commands', line: '/compact', submittedAttachments: []});
    assert.equal(typeof executed.commandId, 'string');
    assert.ok(['success', 'error'].includes(executed.result.kind), JSON.stringify(executed));

    await runtime.dispose();
    runtime = createRuntime(directory, {browser: true});
    const projections = await api.call<{asOfSeq: number}>('session/projections', {request: {sessionId: 'commands'}});
    const page = await api.call<SessionPage>('session/page', {request: {address: {kind: 'session', sessionId: 'commands'}, throughSeq: projections.asOfSeq}});
    const lifecycle = page.records.map(record => record.event).filter(event => event.type === 'command/run' || event.type === 'command/done');
    assert.deepEqual(lifecycle.map(event => event.type), ['command/run', 'command/done']);
    assert.match(JSON.stringify(lifecycle), new RegExp(executed.commandId));
    assert.ok((await api.call<{name: string}[]>('commands/list', {agentId: 'commands'})).some(command => command.name === 'compact'));
  } finally {
    await runtime.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});
