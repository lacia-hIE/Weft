import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Response, type V4FetchHandler} from 'miniflare';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';
import {entryNamespace} from '../packages/package-install/src/contracts.ts';

const plugin = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string; version: string};
const key = 'superagent-management-key', secret = 'superagent-webhook-secret', repository = 'acme/widgets', agent = 'agent-bot';
const issue = {id: 1007, state: 'open', number: 7, title: 'Fix the typo', body: `@${agent} please fix the typo in README`, user: {login: 'alice', type: 'User'}, created_at: '', updated_at: '', html_url: `https://github.com/${repository}/issues/7`};

const quiet = {...issue, id: 1008, number: 8, title: 'QUIET_WORK', html_url: `https://github.com/${repository}/issues/8`};

/** The main Session routes the card it was given; a worker reports ready. Everything else about the Agent and tools is real. */
const model: V4FetchHandler = async request => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const body = await request.json() as {messages: {role: string; content: unknown}[]; tools?: {name: string}[]; system?: unknown};
  const text = JSON.stringify(body.messages);
  const offered = new Set((body.tools ?? []).map(tool => tool.name));
  const called = (name: string) => text.includes(`"name":"${name}"`);
  // A candidate arrives as the newest message, which a tool's result never is.
  const last = JSON.stringify(body.messages.at(-1));
  const candidate = last.includes('tool_result') ? undefined : /trigger_id\\+":\\+"([0-9a-f]{32})/.exec(last)?.[1];
  const call = offered.has('orchestrator_route') && candidate
    ? {name: 'orchestrator_route', input: {decisions: [{kind: 'accept', trigger_id: candidate, title: last.includes('QUIET_WORK') ? 'QUIET_WORK' : 'Fix the typo', worktree_name: 'fix-typo', acknowledgement: 'On it.'}]}}
    : offered.has('orchestrator_report') && !called('orchestrator_report') && !text.includes('QUIET_WORK') ? {name: 'orchestrator_report', input: {state: 'ready', summary: 'Fixed the typo.'}} : undefined;
  return new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: call ? {type: 'tool_use', id: crypto.randomUUID(), name: call.name, input: {}} : {type: 'text', text: ''}}) +
    event('content_block_delta', {index: 0, delta: call ? {type: 'input_json_delta', partial_json: JSON.stringify(call.input)} : {type: 'text_delta', text: 'Done.'}}) +
    event('content_block_stop', {index: 0}) +
    event('message_delta', {delta: {stop_reason: call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}});
};

test('a request on GitHub becomes a Ticket worked on in its own Session, without leaking its tools to other Sessions', {timeout: 300000}, async () => {
  const requests: {system: string; tools: string[]}[] = [], comments: string[] = [];
  let announced: number[] = [];
  const github = async (target: URL, init: Request): Promise<Response> => {
    const path = target.pathname, base = `/repos/${repository}`;
    if (init.headers.get('authorization') !== 'Bearer agent-token') return Response.json({message: 'Bad credentials'}, {status: 401});
    if (path === '/user') return Response.json({login: agent, id: 42});
    if (path === base) return Response.json({full_name: repository, default_branch: 'main', permissions: {push: true}});
    if (path === `${base}/notifications`) return new Response(JSON.stringify(announced.map(number => ({repository: {full_name: repository}, subject: {url: `https://api.github.com${base}/issues/${number}`}}))), {headers: {'content-type': 'application/json', 'x-poll-interval': '60'}});
    if (path === `${base}/issues/7`) return Response.json(issue);
    if (path === `${base}/issues/8`) return Response.json(quiet);
    if (path === `${base}/issues/8/comments`) return init.method === 'POST' ? Response.json({id: 99, user: {login: agent, type: 'User'}, created_at: new Date().toISOString()}, {status: 201}) : Response.json([]);
    if (path === `${base}/issues/7/comments` && init.method === 'POST') {comments.push(String((await init.json() as {body: string}).body)); return Response.json({id: comments.length, html_url: `${issue.html_url}#c${comments.length}`, body: comments.at(-1), user: {login: agent, type: 'User'}, created_at: new Date().toISOString()}, {status: 201});}
    if (path === `${base}/issues/7/comments`) return Response.json([]);
    return Response.json({message: 'Not Found'}, {status: 404});
  };
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'https://superagent-model.test/anthropic'},
    packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'superagent-model.test') {
        const body = await request.clone().json() as {system?: unknown; tools?: {name: string}[]};
        requests.push({system: JSON.stringify(body.system), tools: (body.tools ?? []).map(tool => tool.name)});
        return model(request, mf);
      }
      if (target.hostname === 'api.github.com') return github(target, request as never);
      return new Response('not found', {status: 404});
    },
  });
  const api = nativeClient(() => runtime), tenant = tenantId('alpha'), base = `/v1/tenants/${tenant}/environments/default`;
  const hook = (path: string, init?: RequestInit) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(plugin.name)}${path}`), init as never);
  const panel = (path: string, init?: RequestInit) => hook(`/api/${path}`, {...init, headers: {authorization: `Bearer ${key}`, ...init?.headers}});
  const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
    for (const end = Date.now() + 120_000; Date.now() < end; await delay(500)) {const value = await read(); if (value !== undefined) return value;}
    throw new Error(`${label} did not happen; comments: ${JSON.stringify(comments)}; requests: ${requests.length}`);
  };
  const deliver = async () => {
    const body = JSON.stringify({action: 'opened'});
    return hook('/github', {method: 'POST', body, headers: {'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`}});
  };
  try {
    const offered = (await api.call<BundleInfo[]>('pluginManager/listBundles', {})).find(bundle => bundle.name === plugin.name)!;
    await api.call('pluginManager/installBundle', {spec: offered.installTarget!.spec, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal(row.hostScope, 'environment');
    assert.equal(row.permissions.storage, true, 'transactional state rides the plugin state permission');
    assert.equal(row.permissions.sessions, true, 'managed Sessions ride the Session permission');
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: {...row.permissions, network: true, routes: true, files: 'write'}})})).status, 200);
    const ns = entryNamespace(plugin.name, 'dsh-superagent');
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(candidate => candidate.ns === ns);
    assert.ok(form, `${ns} has a native Settings form`);
    await api.call('settings/update', {ns, patch: {githubToken: 'agent-token', webhookSecret: secret, managementKey: key}, expectedRevision: form.revision});

    assert.equal((await waitFor(async () => {const response = await hook('/api/state'); return response.status === 401 ? response : undefined;}, 'routes')).status, 401, 'the panel routes need the key');
    assert.equal((await hook('/github', {method: 'POST', body: '{}'})).status, 401, 'an unsigned delivery is refused');

    const state = await waitFor(async () => {const response = await panel('state'); return response.status === 200 ? await response.json() as {setup: {problem: {code: string} | null}} : undefined;}, 'state');
    assert.equal(state.setup.problem?.code, 'repositoryUnset');

    const settings = await (await panel('settings')).json() as {sources: {id: string; revision: number}[]};
    const github = settings.sources.find(source => source.id === 'github')!;
    const saved = await panel('settings/source:github', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({revision: github.revision, value: {enabled: true, config: {repository}}})});
    assert.equal(saved.status, 200, await saved.clone().text());
    await waitFor(async () => {const response = await panel('state'); const view = response.status === 200 ? await response.json() as {setup: {accounts: {agent: string} | null}} : undefined; return view?.setup.accounts?.agent === agent ? true : undefined;}, 'setup');
    const current = await (await panel('settings')).json() as {blocks: {policy: {revision: number}}};
    const policy = await panel('settings/policy', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({revision: current.blocks.policy.revision, value: {rules: [], sources: {github: {allowed: [{id: 'alice'}]}}}})});
    assert.equal(policy.status, 200, await policy.clone().text());

    issue.created_at = issue.updated_at = new Date().toISOString();
    announced = [7];
    assert.equal((await deliver()).status, 202, 'a signed delivery wakes the Source');
    const tickets = await waitFor(async () => {
      await deliver();
      // A worker that reports at once may end its Ticket before this looks.
      const lists = await Promise.all(['open', 'ended'].map(async state => await (await panel(`tickets?state=${state}`)).json() as {items?: {id: string; title: string}[]}));
      const items = lists.flatMap(list => list.items ?? []);
      return items.length ? items : undefined;
    }, 'the Ticket').catch(async (error: Error) => {
      throw new Error(`${error.message}; sources: ${await (await panel('sources')).text()}; overview: ${await (await panel('overview')).text()}; triggers: ${await (await panel('threads?filter=all')).text()}`);
    });
    assert.equal(tickets[0]!.title, 'Fix the typo');

    await waitFor(() => comments.some(comment => comment.includes('On it.')) ? true : undefined, 'the acknowledgement on the Issue');
    const worker = await waitFor(() => requests.find(item => item.tools.includes('orchestrator_report')), 'the worker\'s model request');
    assert.ok(worker.system.includes('dsh-superagent prompt revision'), 'the worker runs under the composed instructions');
    assert.ok(!worker.tools.includes('orchestrator_route'), 'a worker is not offered the main Session\'s tools');
    const main = requests.find(item => item.tools.includes('orchestrator_route'))!;
    assert.ok(!main.tools.includes('orchestrator_report'), 'the main Session is not offered a worker\'s tools');

    // Without a pull request, a `ready` report read from the worker's log ends the Ticket as completed.
    await waitFor(async () => {
      const list = await (await panel('tickets?state=ended')).json() as {items?: {id: string}[]};
      return list.items?.some(item => item.id === tickets[0]!.id) ? true : undefined;
    }, 'the Ticket\'s end');

    // A worker whose turn ends without a report is found from its Session's log, and waits for its next Trigger.
    quiet.created_at = quiet.updated_at = new Date().toISOString();
    announced = [8];
    const idle = await waitFor(async () => {
      await deliver();
      const list = await (await panel('tickets?state=idle')).json() as {items?: {id: string; title: string}[]};
      return list.items?.find(item => item.title === 'QUIET_WORK');
    }, 'the worker that ended its turn without a report');
    const detail = await (await panel(`tickets/${idle.id}`)).json() as {inputs?: unknown; assignments?: {report?: {state: string; summary: string}}[]};
    assert.equal(detail.assignments?.at(-1)?.report?.state, 'waiting');
    assert.equal(detail.assignments?.at(-1)?.report?.summary, 'Done.');

    await api.call('session/create', {request: {sessionId: 'personal'}});
    const follow = await api.follow('personal');
    try {
      await follow.next();
      await api.call('session/prompt', {request: {sessionId: 'personal', requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'hello'}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
    const personal = requests.at(-1)!;
    assert.ok(!personal.tools.some(name => name.startsWith('orchestrator_')), 'a person\'s Session is offered none of the tools');
    assert.ok(!personal.system.includes('dsh-superagent prompt revision'), 'a person\'s Session gets none of the instructions');
  } finally {await runtime.dispose();}
});
