import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {nativeTeamModel} from './helpers/native-team-model.ts';
import type {BundleInfo, ChangeResult} from '@deepseek-ai/dsh-plugin-manager/types';

const bundle = '@deepseek-ai/dsh-experimental-agent-team-profile';
const client = '@deepseek-ai/dsh-experimental-client-ui-agent-team';
test('official patch installs real Team tools, persists roster/tasks, restores peer inboxes and preserves frozen Sessions', {timeout: 180000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-teams-'));
  const model = nativeTeamModel();
  const options = {browser: true, bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'team-fixture', DEEPSEEK_BASE_URL: 'https://team-model.test/anthropic'}, outbound: model.outbound};
  let runtime = createRuntime(directory, options);
  const api = nativeClient(() => runtime);
  const other = nativeClient(() => runtime, 'default', 'beta');
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
  type TeamView = {members: {id: string; name: string; phase: string}[]; tasks: {id: string; subject: string; revision: number}[]};
  const projection = async () => (await api.call<{values: {agentTeam: TeamView}}>('session/projections', {request: {sessionId: 'team-lead'}})).values.agentTeam;
  try {
    assert.equal((await boot()).entries.some(row => row.id === client), false);
    await api.call('session/create', {request: {sessionId: 'old-session', agentPreset: 'standard'}});
    const available = (await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(row => row.name === bundle)!;
    assert.equal(available.installed, false); assert.ok(available.installTarget);
    const wrong = await api.call<ChangeResult>('pluginManager/installBundle', {spec: bundle+'@99.0.0'});
    assert.equal(wrong.application, 'failed');
    const privateSource = await api.call<{status: string}>('pluginManager/inspect', {spec: bundle, options: {registry: 'https://private.invalid'}});
    assert.equal(privateSource.status, 'refused');
    const install = await api.call<ChangeResult>('pluginManager/installBundle', {spec: available.installTarget.spec, options: {registry: 'https://registry.npmjs.org/'}});
    assert.equal(install.application, 'applied'); assert.equal(install.enabled, true);
    assert.equal((await boot()).entries.some(row => row.id === client), true);
    assert.equal((await other.call<BundleInfo[]>('pluginManager/listBundles', {})).find(row => row.name === bundle)?.installed, false);
    const presets = await api.call<unknown>('agentPresets/list', {});
    assert.doesNotMatch(JSON.stringify(presets), /waiting for agentTeams|Preset services require isolate realms/);
    await api.call('session/create', {request: {sessionId: 'team-lead', agentPreset: 'standard'}});
    await run('team-lead', 'CREATE_TEAM');
    let team = await projection();
    assert.equal(team.members.find(row => row.name === 'reviewer')?.phase, 'active');
    assert.equal(team.tasks[0]?.subject, 'Review plugin integration');
    const childId = team.members.find(row => row.name === 'reviewer')!.id;
    const rootCalls = model.observations.filter(row => !row.child);
    assert.ok(rootCalls.some(row => row.tools.includes('spawn_teammate')));
    assert.ok(rootCalls.every(row => !row.tools.includes('subagent') && !row.tools.includes('subagent_fork')));
    assert.ok(rootCalls.every(row => row.tools.filter(name => name === 'send_message').length === 1));
    await run('old-session', 'FROZEN_BEFORE_INSTALL');
    assert.equal(model.observations.find(row => row.body.includes('FROZEN_BEFORE_INSTALL'))?.tools.includes('spawn_teammate'), false);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    // Read-only cold projection must restore the official fold without starting an Agent.
    team = await projection();
    assert.equal(team.members.find(row => row.name === 'reviewer')?.id, childId);
    assert.equal(team.tasks[0]?.revision, 1);
    await run('team-lead', 'MESSAGE_TEAM');
    for (let attempt = 0; attempt < 200 && !model.observations.some(row => row.child && row.body.includes('WAKE_TEAM')); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(model.observations.some(row => row.child && row.body.includes('WAKE_TEAM')), 'a peer send cold-restores the teammate inbox');
    const disabled = await api.call<ChangeResult>('pluginManager/setBundleEnabled', {name: bundle, enabled: false});
    assert.equal(disabled.application, 'applied');
    assert.equal((await boot()).entries.some(row => row.id === client), false);
    await api.call('session/create', {request: {sessionId: 'after-disable', agentPreset: 'standard'}});
    await run('after-disable', 'AFTER_DISABLE');
    assert.equal(model.observations.find(row => row.body.includes('AFTER_DISABLE'))?.tools.includes('spawn_teammate'), false);
    assert.equal((await projection()).members.find(row => row.name === 'reviewer')?.id, childId);
    assert.equal((await api.call<ChangeResult>('pluginManager/removeBundle', {name: bundle})).changed, true);
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.equal((await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(row => row.name === bundle)?.installed, false);
    assert.equal((await projection()).tasks[0]?.subject, 'Review plugin integration');
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});
