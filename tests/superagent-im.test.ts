import assert from 'node:assert/strict';
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

const superagent = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string};
const im = JSON.parse(readFileSync('plugins/im/package.json', 'utf8')) as {name: string};
const key = 'superagent-management-key', repository = 'acme/widgets', agent = 'agent-bot';

/** The main Session accepts the candidate it was given; a worker reports ready. */
const model: V4FetchHandler = async request => {
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const body = await request.json() as {messages: {role: string; content: unknown}[]; tools?: {name: string}[]};
  const text = JSON.stringify(body.messages);
  const offered = new Set((body.tools ?? []).map(tool => tool.name));
  const last = JSON.stringify(body.messages.at(-1));
  const candidate = last.includes('tool_result') ? undefined : /trigger_id\\+":\\+"([0-9a-f]{32})/.exec(last)?.[1];
  const call = offered.has('orchestrator_route') && candidate
    ? {name: 'orchestrator_route', input: {decisions: [{kind: 'accept', trigger_id: candidate, title: 'Fix the Feishu typo', worktree_name: 'fix-feishu-typo', acknowledgement: 'FEISHU_ACK'}]}}
    : offered.has('orchestrator_report') && !text.includes('"name":"orchestrator_report"') ? {name: 'orchestrator_report', input: {state: 'ready', summary: 'Fixed the typo.'}} : undefined;
  return new Response(
    event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
    event('content_block_start', {index: 0, content_block: call ? {type: 'tool_use', id: crypto.randomUUID(), name: call.name, input: {}} : {type: 'text', text: ''}}) +
    event('content_block_delta', {index: 0, delta: call ? {type: 'input_json_delta', partial_json: JSON.stringify(call.input)} : {type: 'text_delta', text: 'Done.'}}) +
    event('content_block_stop', {index: 0}) +
    event('message_delta', {delta: {stop_reason: call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}});
};

test('a Feishu bot that dsh-im assigns to dsh-superagent turns a direct message into a Ticket and acknowledges it through the same bot', {timeout: 300000}, async () => {
  const replies: {path: string; body: Record<string, unknown>; authorization: string | null}[] = [];
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'https://superagent-model.test/anthropic'},
    packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'superagent-model.test') return model(request, mf);
      if (target.hostname === 'api.github.com') {
        if (request.headers.get('authorization') !== 'Bearer agent-token') return Response.json({message: 'Bad credentials'}, {status: 401});
        if (target.pathname === '/user') return Response.json({login: agent, id: 42});
        if (target.pathname === `/repos/${repository}`) return Response.json({full_name: repository, default_branch: 'main', permissions: {push: true}});
        return Response.json({message: 'Not Found'}, {status: 404});
      }
      if (target.hostname === 'open.feishu.cn') {
        if (target.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({code: 0, tenant_access_token: 'feishu-token', expire: 7200});
        if (target.pathname.startsWith('/open-apis/cardkit/')) return Response.json({code: 99991672, msg: 'no permission'});
        const text = request.method === 'GET' ? '' : await request.text();
        replies.push({path: target.pathname, body: text ? JSON.parse(text) as Record<string, unknown> : {}, authorization: request.headers.get('authorization')});
        return Response.json({code: 0, data: {message_id: 'om_reply'}});
      }
      return new Response('not found', {status: 404});
    },
  });
  const api = nativeClient(() => runtime), tenant = tenantId('alpha'), base = `/v1/tenants/${tenant}/environments/default`;
  const hook = (name: string, path: string, init?: RequestInit) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(name)}${path}`), init as never);
  const panel = (path: string, init?: RequestInit) => hook(superagent.name, `/api/${path}`, {...init, headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init?.headers}});
  const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
    for (const end = Date.now() + 120_000; Date.now() < end; await delay(500)) {const value = await read(); if (value !== undefined) return value;}
    throw new Error(`${label} did not happen; replies: ${JSON.stringify(replies)}`);
  };
  const configure = async (name: string, entry: string, patch: Record<string, unknown>) => {
    const ns = entryNamespace(name, entry);
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(candidate => candidate.ns === ns);
    assert.ok(form, `${ns} has a native Settings form`);
    await api.call('settings/update', {ns, patch, expectedRevision: form.revision});
  };
  try {
    const bundles = await api.call<BundleInfo[]>('pluginManager/listBundles', {});
    for (const name of [im.name, superagent.name]) {
      const offered = bundles.find(bundle => bundle.name === name)!;
      await api.call('pluginManager/installBundle', {spec: offered.installTarget!.spec, options: {requestId: crypto.randomUUID()}});
      const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations.find(item => item.name === name)!;
      assert.equal(row.permissions.sessions, true, `${name} routes IM bots with the Session permission`);
      assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: {...row.permissions, network: true, routes: true, files: 'write'}})})).status, 200);
    }
    await configure(superagent.name, 'dsh-superagent', {githubToken: 'agent-token', managementKey: key});
    const settings = await waitFor(async () => {const response = await panel('settings'); return response.status === 200 ? await response.json() as {sources: {id: string; revision: number}[]; blocks: {policy: {revision: number}}} : undefined;}, 'the panel');
    const source = (id: string) => settings.sources.find(item => item.id === id)!;
    assert.ok(source('feishu') && source('weixin') && source('qq') && source('email'), 'every IM channel has a Source');
    assert.equal((await panel('settings/source:feishu', {method: 'PUT', body: JSON.stringify({revision: source('feishu').revision, value: {enabled: true, config: {bot: 'feishu', directMessages: true}}})})).status, 200);
    assert.equal((await panel('settings/source:github', {method: 'PUT', body: JSON.stringify({revision: source('github').revision, value: {enabled: true, config: {repository}}})})).status, 200);
    await waitFor(async () => {const response = await panel('state'); const view = response.status === 200 ? await response.json() as {setup: {accounts: {agent: string} | null}} : undefined; return view?.setup.accounts?.agent === agent ? true : undefined;}, 'setup');
    const current = await (await panel('settings')).json() as {blocks: {policy: {revision: number}}};
    const policy = await panel('settings/policy', {method: 'PUT', body: JSON.stringify({revision: current.blocks.policy.revision, value: {rules: [], sources: {feishu: {allowed: [{id: 'ou_alice', name: 'Alice'}]}}}})});
    assert.equal(policy.status, 200, await policy.clone().text());

    // The first Feishu bot of dsh-im is assigned to dsh-superagent: its messages leave IM Sessions.
    await configure(im.name, 'im-feishu', {enabled: true, managementKey: 'feishu-management', appId: 'cli_fixture', appSecret: 'feishu-secret', verificationToken: 'feishu-verify', consumer: superagent.name});
    const consumers = await waitFor(async () => {
      const response = await hook(im.name, '/feishu/consumers', {headers: {authorization: 'Bearer feishu-management'}});
      const value = response.status === 200 ? await response.json() as {consumers: string[]} : undefined;
      return value?.consumers.includes(superagent.name) ? value.consumers : undefined;
    }, 'dsh-superagent consuming IM events');
    assert.deepEqual(consumers, [superagent.name], 'dsh-im itself does not consume IM events');
    const offered = await waitFor(async () => {
      if ((await panel('sources/feishu/labels', {method: 'POST'})).status !== 200) return undefined;
      const view = await (await panel('settings')).json() as {sources: {id: string; labels?: Record<string, string>}[]};
      const labels = view.sources.find(item => item.id === 'feishu')?.labels ?? {};
      return 'feishu' in labels ? labels : undefined;
    }, 'the assigned bot among the Feishu Source\'s bot choices');
    assert.deepEqual(offered, {feishu: 'feishu'}, 'only bots assigned to dsh-superagent are offered');
    const event = JSON.stringify({schema: '2.0', header: {event_id: crypto.randomUUID(), event_type: 'im.message.receive_v1', token: 'feishu-verify', app_id: 'cli_fixture'},
      event: {sender: {sender_id: {open_id: 'ou_alice'}, sender_type: 'user'}, message: {message_id: 'om_request', chat_id: 'oc_alice', chat_type: 'p2p', message_type: 'text', create_time: String(Date.now()), content: JSON.stringify({text: 'Please fix the typo in README'})}}});
    // Delivery repeats until the Ticket exists; every delivery of one message is the same Trigger.
    const tickets = await waitFor(async () => {
      assert.equal((await hook(im.name, '/feishu', {method: 'POST', headers: {'content-type': 'application/json'}, body: event})).status, 200);
      const lists = await Promise.all(['open', 'ended'].map(async state => await (await panel(`tickets?state=${state}`)).json() as {items?: {title: string}[]}));
      const items = lists.flatMap(list => list.items ?? []);
      return items.length ? items : undefined;
    }, 'the Ticket').catch(async (error: Error) => {
      throw new Error(`${error.message}; sources: ${await (await panel('sources')).text()}; triggers: ${await (await panel('threads?filter=all')).text()}`);
    });
    assert.equal(tickets[0]!.title, 'Fix the Feishu typo');
    const ack = await waitFor(() => replies.find(reply => reply.path === '/open-apis/im/v1/messages/om_request/reply' && JSON.stringify(reply.body).includes('FEISHU_ACK')), 'the acknowledgement on Feishu');
    assert.equal(ack.authorization, 'Bearer feishu-token', 'the acknowledgement goes out as the bot that received the request');
    assert.match(String(ack.body.uuid), /^[0-9a-f-]{36}$/, 'a retried acknowledgement is the same Feishu message');
    const sources = await (await panel('sources')).json() as {id: string; state: string}[];
    assert.equal(sources.find(row => row.id === 'feishu')?.state, 'ready');
    const sessions = (await api.call<{items: {title?: string}[]}>('session/list', {_request: {}})).items;
    assert.ok(!sessions.some(session => session.title?.startsWith('飞书 · ')), 'an assigned bot opens no IM Session');
    // A configured connector instance uses its own Source identity through the native IM carrier.
    const connections=await(await panel('source-bots')).json() as {bot:string;kind:string}[];assert.equal(connections.some(row=>row.bot==='feishu'),true);
    const created=await panel('sources',{method:'POST',body:JSON.stringify({kind:'feishu',name:'Connected Feishu',config:{bot:'feishu'}})});
    assert.equal(created.status,200,await created.clone().text());const connection=await created.json() as {id:string};
    const readConnections=async()=>await(await panel('settings')).json() as {sources:{id:string;revision:number;value:Record<string,unknown>}[];blocks:{policy:{revision:number;value:{rules:unknown[];sources:Record<string,unknown>}}}};
    let configured=await readConnections(),instance=configured.sources.find(row=>row.id===connection.id)!;
    const duplicate=await panel(`settings/source:${connection.id}`,{method:'PUT',body:JSON.stringify({revision:instance.revision,value:{...instance.value,enabled:true}})});assert.equal(duplicate.status,400,'one active connection owns a bot delivery');
    const old=configured.sources.find(row=>row.id==='feishu')!;
    assert.equal((await panel('sources/feishu',{method:'DELETE',body:JSON.stringify({revision:old.revision})})).status,200);
    configured=await readConnections();instance=configured.sources.find(row=>row.id===connection.id)!;
    assert.equal((await panel(`settings/source:${connection.id}`,{method:'PUT',body:JSON.stringify({revision:instance.revision,value:{...instance.value,enabled:true}})})).status,200);
    configured=await readConnections();const currentPolicy=configured.blocks.policy;
    assert.equal((await panel('settings/policy',{method:'PUT',body:JSON.stringify({revision:currentPolicy.revision,value:{...currentPolicy.value,sources:{...currentPolicy.value.sources,[connection.id]:{allowed:[{id:'ou_alice'}],mode:'off'}}}})})).status,200);
    const nextEvent=JSON.parse(event);nextEvent.header.event_id=crypto.randomUUID();nextEvent.event.message.message_id='om_connected_request';nextEvent.event.message.create_time=String(Date.now());
    await hook(im.name,'/feishu',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(nextEvent)});
    const nextAck=await waitFor(()=>replies.find(reply=>reply.path==='/open-apis/im/v1/messages/om_connected_request/reply'&&JSON.stringify(reply.body).includes('FEISHU_ACK')),'acknowledgement through an independent Feishu connection');
    assert.equal(nextAck.authorization,'Bearer feishu-token');
    const threads=await(await panel('threads?filter=all')).text();assert.equal(threads.includes(connection.id),true,'native IM delivery is scoped to the configured Source identity');

  } finally {await runtime.dispose();}
});
