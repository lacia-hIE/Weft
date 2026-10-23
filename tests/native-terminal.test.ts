import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

test('the official terminal controller starts in its selected project and runs a line terminal over the Computer shell', {timeout: 120_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  const abort = new AbortController();
  try {
    await api.call('directoryPicker/createDirectory', {path: '/workspace', name: 'project'});
    const {workspace} = await api.call<{workspace: {workspaceId: string}}>('workspace/create', {request: {path: '/workspace/project'}});
    await api.call('session/create', {request: {sessionId: 'term', workspaceId: workspace.workspaceId}});
    const shells = await api.call<{path: string}[]>('terminal/shells', {agentId: 'term'});
    assert.deepEqual(shells.map(shell => shell.path), ['/bin/bash']);
    const created = await api.call<{id: string; state: string}>('terminal/create', {agentId: 'term', request: {id: 'main', cols: 80, rows: 24}});
    assert.equal(created.state, 'running');
    assert.deepEqual((await api.call<{id: string}[]>('terminal/list', {sessionId: 'term'})).map(terminal => terminal.id), ['main']);

    const streamId = crypto.randomUUID();
    const response = await runtime.dispatchFetch(url('alpha', `${base}/streams/terminal/attach`), {
      method: 'POST', headers: {'content-type': 'application/json', 'x-weft-stream-id': streamId}, body: JSON.stringify({args: {agentId: 'term', id: 'main'}}), signal: abort.signal,
    });
    assert.match(response.headers.get('content-type') ?? '', /event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let screen = '';
    const until = async (pattern: RegExp) => {
      for (let pending = ''; !pattern.test(screen);) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, `stream ended before ${pattern}: ${screen}`);
        pending += decoder.decode(chunk.value, {stream: true});
        for (let index = pending.indexOf('\n\n'); index >= 0; index = pending.indexOf('\n\n')) {
          const data = pending.slice(0, index).split('\n').find(line => line.startsWith('data: '))?.slice(6);
          pending = pending.slice(index + 2);
          if (!data) continue;
          const frame = JSON.parse(data) as {type: string; data?: string; screen?: string};
          screen += frame.type === 'output' ? frame.data : frame.type === 'snapshot' ? frame.screen : '';
        }
      }
    };
    let sequence = 0;
    const type = (data: string, end = false) => api.call('$stream/input', {streamId, endpoint: 'terminal/attach', args: {agentId: 'term', id: 'main'}, items: [{type: 'write', sequence: ++sequence, data}], end});
    await until(/weft.*\$ /);
    await type('pwd\r');
    await until(/\/workspace\/project\r?\n/);
    await type('mkdir -p sub && cd sub && echo terminal-$((40+2))\r');
    await until(/terminal-42/);
    await until(/~\/project\/sub.*\$ /);
    await type('pwd\r');
    await until(/\/workspace\/project\/sub\r?\n/);
    await type('echo pending-line\u0003');
    await until(/\^C/);
    await api.call('terminal/close', {agentId: 'term', id: 'main'});
  } finally {
    abort.abort();
    await runtime.dispose();
  }
});
