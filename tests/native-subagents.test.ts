import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {SessionFollowFrame} from '@deepseek-ai/dsh-api-session-controller/types';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeSubagentModel} from './helpers/native-subagent-model.ts';
import {unzipSync, strFromU8} from 'fflate';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session/types';
import {sessionFormatLogFilename} from '@weft/upstream/packages/session/session-format/src/filename.ts';

const SESSION_LOG_FILENAME = sessionFormatLogFilename(SESSION_FORMAT_VERSION);

test('native delegation owns real child logs, live history, browser continuation and cold recovery', {timeout: 120000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-subagents-'));
  const provider = nativeSubagentModel();
  const options = {bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'subagent-fixture', DEEPSEEK_BASE_URL: 'https://subagent-model.test/anthropic'}, outbound: provider.outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  let parent: Awaited<ReturnType<typeof api.follow>> | undefined;
  let child: Awaited<ReturnType<typeof api.stream<SessionFollowFrame>>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'parent', agentPreset: 'standard'}});
    parent = await api.follow('parent'); await parent.next();
    await api.call('session/prompt', {request: {sessionId: 'parent', requestId: 'delegate-request', mode: 'queue', content: [{type: 'text', text: 'PARENT_TASK: delegate a native task'}]}});
    let childId: string | undefined;
    for (;;) {
      const frame = await parent.next();
      if (frame.type === 'event' && frame.event.type === 'subagent/catalog') childId = (frame.event.data as {childId: string}).childId;
      if (frame.type === 'event' && frame.event.type === 'turn/end') break;
    }
    assert.ok(childId, 'the native tool must create an actual catalog entry');
    await provider.ready;
    const address = {kind: 'subagent', parentSessionId: 'parent', childSessionId: childId, mode: 'continuable'};
    child = await api.stream<SessionFollowFrame>('session/follow', {request: {address, assistantStream: true}});
    const opening = await child.next(); assert.equal(opening.type, 'snapshot');
    if (opening.type !== 'snapshot') throw Error('Missing child snapshot');
    assert.equal(opening.header.id, childId); assert.equal(opening.header.origin, 'subagent');
    const records = JSON.stringify(opening.records);
    assert.match(records, /CHILD_TASK_ALPHA/); assert.doesNotMatch(records, /PARENT_TASK/);
    assert.doesNotMatch(records, /"type":"turn\/end"/, 'a live child observation cannot synthesize interruption closers');
    provider.release();
    let frameSeen = false;
    for (;;) {const frame = await child.next(); if (frame.type === 'assistant-stream') frameSeen = true; if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    assert.equal(frameSeen, true, 'child assistant frames must retain their real producer');
    const foreign = await nativeClient(() => runtime, 'default', 'beta').raw('subagents/prompt', {request: {parentSessionId: 'parent', childSessionId: childId, mode: 'continuable', delivery: 'queue', requestId: 'forged-user', content: [{type: 'text', text: 'foreign'}]}});
    assert.equal(foreign.result.error?.code, 'subagent/not-found');
    await api.call('session/create', {request: {sessionId: 'unrelated'}});
    const references = await api.call<{sessionId: string; displayTitle: string}[]>('sessionReferenceResolver/candidates', {agentId: 'unrelated', query: ''});
    assert.equal(references.find(item => item.sessionId === childId)?.displayTitle, 'Native delegated task', 'cross-root reference discovery preserves the original child label');
    const unrelated = await api.raw('subagents/prompt', {request: {parentSessionId: 'unrelated', childSessionId: childId, mode: 'continuable', delivery: 'queue', requestId: 'forged-parent', content: [{type: 'text', text: 'foreign'}]}});
    assert.equal(unrelated.result.ok, false);
    await api.call('subagents/prompt', {request: {parentSessionId: 'parent', childSessionId: childId, mode: 'continuable', delivery: 'queue', requestId: 'child-follow', content: [{type: 'text', text: 'CHILD_FOLLOW_BETA'}]}});
    for (;;) {const frame = await child.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    const projection = await api.call<unknown>('session/projections', {request: {sessionId: childId}});
    assert.match(JSON.stringify(projection), /continuable/);
    const search = await api.call<{items: {sessionId: string}[]}>('session/search', {request: {query: 'CHILD_FOLLOW_REPLY'}});
    assert.ok(search.items.some(item => item.sessionId === childId), 'native child message search keeps its logical address');
    await child.close(); child = undefined; await parent.close(); parent = undefined;
    await runtime.dispose(); runtime = createRuntime(directory, options);
    child = await api.stream<SessionFollowFrame>('session/follow', {request: {address}});
    const restored = await child.next(); assert.equal(restored.type, 'snapshot');
    assert.match(JSON.stringify(restored), /CHILD_FOLLOW_REPLY/);
    const roots = await api.call<{items: {sessionId: string; agentAvailable: boolean; origin?: string}[]}>('session/list', {_request: {}});
    assert.deepEqual(roots.items.filter(item => item.origin !== 'subagent').map(item => item.sessionId).sort(), ['parent', 'unrelated']);
    assert.ok(roots.items.some(item => item.sessionId === childId && item.origin === 'subagent')); assert.ok(roots.items.every(item => !item.agentAvailable));
    const exported = async (sessionId: string, includeDescendants: boolean) => {
      const query = new URLSearchParams({sessionId, includeDescendants: String(includeDescendants)});
      const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/native/api/session.export?${query}`));
      assert.equal(response.status, 200);
      return unzipSync(new Uint8Array(await response.arrayBuffer()));
    };
    const tree = await exported('parent', true);
    assert.deepEqual(Object.keys(tree).sort(), [SESSION_LOG_FILENAME, `subagents/${childId}/${SESSION_LOG_FILENAME}`].sort());
    assert.match(strFromU8(tree[`subagents/${childId}/${SESSION_LOG_FILENAME}`]!), /CHILD_FOLLOW_REPLY/);
    assert.deepEqual(Object.keys(await exported('parent', false)), [SESSION_LOG_FILENAME]);
    const childOnly = await exported(childId, true);
    assert.deepEqual(Object.keys(childOnly), [SESSION_LOG_FILENAME]);
    assert.match(strFromU8(childOnly[SESSION_LOG_FILENAME]!), /CHILD_FOLLOW_REPLY/);
    assert.doesNotMatch(strFromU8(childOnly[SESSION_LOG_FILENAME]!), /PARENT_TASK/);
    assert.ok((await api.call<{items: {agentAvailable: boolean}[]}>('session/list', {_request: {}})).items.every(item => !item.agentAvailable));
    await api.call('subagents/prompt', {request: {parentSessionId: 'parent', childSessionId: childId, mode: 'continuable', delivery: 'queue', requestId: 'child-after-restart', content: [{type: 'text', text: 'CHILD_FOLLOW_BETA after restart'}]}});
    for (;;) {const frame = await child.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    assert.ok(provider.observations.filter(entry => entry.child).length >= 3);
  } finally {provider.release(); await child?.close(); await parent?.close(); await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('native fork seeds completed parent history and native interrupt cancels the actual child', {timeout: 120000}, async () => {
  const provider = nativeSubagentModel();
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'fork-fixture', DEEPSEEK_BASE_URL: 'https://subagent-model.test/anthropic'}, outbound: provider.outbound});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  let child: Awaited<ReturnType<typeof api.stream<SessionFollowFrame>>> | undefined;
  try {
    await api.call('agentPresets/list', {});
    const base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
    const profile = await (await runtime.dispatchFetch(url('alpha', base+'/agents/standard'))).json() as {revision: number; spec: {plugins: {id: string; config: object}[]}};
    const spec = {...profile.spec, plugins: profile.spec.plugins.map(plugin => plugin.id === 'tool-subagent' ? {...plugin, config: {provider: 'fork'}} : plugin)};
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/agents'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({spec, expectedRevision: profile.revision})})).status, 200);
    await api.call('session/create', {request: {sessionId: 'parent', agentPreset: 'standard'}});
    follow = await api.follow('parent'); await follow.next();
    const prompt = async (requestId: string, text: string) => api.call('session/prompt', {request: {sessionId: 'parent', requestId, mode: 'queue', content: [{type: 'text', text}]}});
    await prompt('prelude', 'COMPLETED_PARENT_PRELUDE');
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await prompt('fork', 'PARENT_TASK: fork a native task');
    let childId: string | undefined;
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'subagent/catalog') childId = (frame.event.data as {childId: string}).childId; if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    assert.ok(childId); await provider.ready;
    const address = {kind: 'subagent', parentSessionId: 'parent', childSessionId: childId, mode: 'continuable'};
    child = await api.stream<SessionFollowFrame>('session/follow', {request: {address}});
    const snapshot = await child.next(); assert.equal(snapshot.type, 'snapshot');
    assert.match(JSON.stringify(snapshot), /COMPLETED_PARENT_PRELUDE/);
    assert.doesNotMatch(JSON.stringify(snapshot), /PARENT_TASK: fork a native task/, 'the in-flight parent turn is not inherited');
    assert.deepEqual(await api.call('subagents/interruptByParent', {parentSessionId: 'parent', childSessionId: childId, mode: 'continuable'}), {accepted: true});
    provider.release();
    for (;;) {const frame = await child.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') {assert.equal((frame.event.data as {reason: {kind: string}}).reason.kind, 'aborted'); break;}}
    await api.call('settings/update', {ns: 'subagent', patch: {maxDepth: 0, maxActiveSubagents: 1}, expectedRevision: 0});
    const settings = await api.call<{namespaces: {ns: string; value: object}[]}>('settings/describe', {});
    assert.deepEqual(settings.namespaces.find(ns => ns.ns === 'subagent')?.value, {maxDepth: 0, maxActiveSubagents: 1});
  } finally {provider.release(); await child?.close(); await follow?.close(); await runtime.dispose();}
});

test('the official delegation limits apply to an already live parent before its next tool call', async () => {
  const provider = nativeSubagentModel();
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'depth-fixture', DEEPSEEK_BASE_URL: 'https://subagent-model.test/anthropic'}, outbound: provider.outbound});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'parent', agentPreset: 'standard'}});
    follow = await api.follow('parent'); await follow.next();
    const prompt = (text: string) => api.call('session/prompt', {request: {sessionId: 'parent', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
    await prompt('Initialize a live parent');
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    await api.call('settings/update', {ns: 'subagent', patch: {maxDepth: 0}, expectedRevision: 0});
    await prompt('PARENT_TASK: delegation is now forbidden');
    let rejected = false;
    for (;;) {
      const frame = await follow.next();
      if (frame.type !== 'event') continue;
      assert.notEqual(frame.event.type, 'subagent/catalog');
      if (frame.event.type === 'tool/result') rejected ||= /depth/i.test(JSON.stringify(frame.event.data));
      if (frame.event.type === 'turn/end') break;
    }
    assert.equal(rejected, true, 'the real native depth guard must reject the tool');
    assert.equal(provider.observations.filter(entry => entry.child).length, 0);
  } finally {provider.release(); await follow?.close(); await runtime.dispose();}
});

test('archive reports native child activity while the parent is idle and explicitly cancels its running descendants', async () => {
  const provider = nativeSubagentModel();
  const runtime = createRuntime(undefined, {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'archive-fixture', DEEPSEEK_BASE_URL: 'https://subagent-model.test/anthropic'}, outbound: provider.outbound});
  const api = nativeClient(() => runtime);
  let follow: Awaited<ReturnType<typeof api.follow>> | undefined;
  let child: Awaited<ReturnType<typeof api.stream<SessionFollowFrame>>> | undefined;
  try {
    await api.call('session/create', {request: {sessionId: 'parent', agentPreset: 'standard'}});
    follow = await api.follow('parent'); await follow.next();
    await api.call('session/prompt', {request: {sessionId: 'parent', requestId: 'archive-test', mode: 'queue', content: [{type: 'text', text: 'PARENT_TASK: start a long child task'}]}});
    let childId: string | undefined;
    for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'subagent/catalog') childId = (frame.event.data as {childId: string}).childId; if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    assert.ok(childId); await provider.ready;
    child = await api.stream<SessionFollowFrame>('session/follow', {request: {address: {kind: 'subagent', parentSessionId: 'parent', childSessionId: childId, mode: 'continuable'}}});
    await child.next();
    const blocked = await api.raw('workspace/archiveSession', {request: {sessionId: 'parent'}});
    assert.equal(blocked.result.error?.code, 'workspace/session-active');
    assert.match(JSON.stringify(blocked.result.error?.details), /subagent/); assert.match(JSON.stringify(blocked.result.error?.details), new RegExp(childId));
    const archived = await api.call<{archivedSessionIds: string[]}>('workspace/archiveSession', {request: {sessionId: 'parent', stopActivity: true}});
    assert.deepEqual(archived.archivedSessionIds, ['parent']);
    provider.release();
    for (;;) {const frame = await child.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') {assert.equal((frame.event.data as {reason: {kind: string}}).reason.kind, 'aborted'); break;}}
  } finally {provider.release(); await child?.close(); await follow?.close(); await runtime.dispose();}
});
