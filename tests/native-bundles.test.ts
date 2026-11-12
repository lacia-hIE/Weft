import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeTeamModel} from './helpers/native-team-model.ts';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';

const retired = '@deepseek-ai/dsh-experimental-agent-team-profile';
const client = '@deepseek-ai/dsh-client-ui-agent-team';
const taskTools = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'];

test('Team mode is a per-root-Session selection: real task tools, persisted board, named teammates and cold peer inboxes', {timeout: 180000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-teams-'));
  const model = nativeTeamModel();
  const options = {bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'team-fixture', DEEPSEEK_BASE_URL: 'https://team-model.test/anthropic'}, outbound: model.outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const boot = async () => {
    const response = await runtime.dispatchFetch(url('alpha', `/v1/tenants/${tenantId('alpha')}/environments/default/native/plugins/boot`));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return await response.json() as {entries: {id: string}[]};
  };
  const run = async (sessionId: string, text: string) => {
    const follow = await api.follow(sessionId); await follow.next();
    try {
      await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
  };
  type Views = {agentTeam: {enabled: boolean; tasks: {id: string; subject: string; revision: number; writeScopes: string[]}[]}; subagentCatalog: {id: string; name?: string}[]};
  const views = async (sessionId = 'team-lead') => (await api.call<{values: Views}>('session/projections', {request: {sessionId}})).values;
  const observed = (marker: string) => model.observations.filter(row => !row.child && row.body.includes(marker));
  try {
    // Agent Teams ships in the base and Web bundles; the former optional bundle is gone.
    assert.equal((await boot()).entries.some(row => row.id === client), true);
    assert.equal((await api.call<BundleInfo[]>('pluginManager/listBundles', {})).some(row => row.name === retired), false);

    await api.call('session/create', {request: {sessionId: 'team-lead', agentPreset: 'standard'}});
    await api.call('session/create', {request: {sessionId: 'solo', agentPreset: 'standard'}});
    assert.equal((await views()).agentTeam.enabled, false, 'new Sessions default to Team mode off');
    await run('team-lead', 'BEFORE_TEAM');
    assert.ok(observed('BEFORE_TEAM').every(row => taskTools.every(name => !row.tools.includes(name))));

    await api.call('agentTeams/setEnabled', {agentId: 'team-lead', enabled: true});
    assert.equal((await views()).agentTeam.enabled, true);
    await run('team-lead', 'CREATE_TEAM');
    const lead = observed('CREATE_TEAM');
    assert.ok(lead.some(row => taskTools.every(name => row.tools.includes(name))));
    assert.ok(lead.some(row => row.body.includes('Agent Teams is available in this session')), 'Team policy reaches the system prompt');
    let state = await views();
    assert.equal(state.agentTeam.tasks[0]?.subject, 'Review plugin integration');
    assert.deepEqual(state.agentTeam.tasks[0]?.writeScopes, ['packages/native-bundles']);
    const childId = state.subagentCatalog.find(row => row.name === 'reviewer')?.id;
    assert.ok(childId, 'the teammate is a named subagent of the root');

    // The selection belongs to one root Session.
    assert.equal((await views('solo')).agentTeam.enabled, false);
    await run('solo', 'SOLO_SESSION');
    assert.ok(observed('SOLO_SESSION').every(row => taskTools.every(name => !row.tools.includes(name))));
    assert.equal((await api.raw('agentTeams/setEnabled', {agentId: childId, enabled: false})).result.error !== undefined, true, 'only the root changes Team mode');

    await runtime.dispose(); runtime = createRuntime(directory, options);
    // A read-only cold projection restores the board and selection without starting an Agent.
    state = await views();
    assert.equal(state.agentTeam.enabled, true);
    assert.equal(state.agentTeam.tasks[0]?.revision, 1);
    assert.equal(state.subagentCatalog.find(row => row.name === 'reviewer')?.id, childId);
    await run('team-lead', 'MESSAGE_TEAM');
    for (let attempt = 0; attempt < 150 && !model.observations.some(row => !row.child && row.body.includes('REVIEWER_ACK')); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(model.observations.some(row => row.child && row.body.includes('WAKE_TEAM')), 'a peer send cold-restores the teammate inbox');
    assert.ok(model.observations.some(row => !row.child && row.body.includes('REVIEWER_ACK')), 'the teammate can message its Lead back');

    await api.call('agentTeams/setEnabled', {agentId: 'team-lead', enabled: false});
    await run('team-lead', 'AFTER_DISABLE');
    assert.ok(observed('AFTER_DISABLE').every(row => taskTools.every(name => !row.tools.includes(name))));
    state = await views();
    assert.equal(state.agentTeam.enabled, false);
    assert.equal(state.agentTeam.tasks[0]?.subject, 'Review plugin integration', 'turning Team mode off keeps the task board');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
