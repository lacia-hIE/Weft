import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Response} from 'miniflare';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import {entryNamespace, type Installation} from '../packages/package-install/src/contracts.ts';

test('executor selection persists without requiring GitHub setup', {timeout: 60000}, async () => {
  const plugin = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string; version: string};
  let githubReads = 0;
  const runtime = createRuntime(undefined, {packages: true,
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'https://local-request-model.test/anthropic'},
    outbound: async request => {
      if (new URL(request.url).hostname === 'api.github.com') {githubReads++; return Response.json({message:'unavailable'}, {status:503});}
      const body = await request.json() as {messages: unknown[]; tools?: {name:string}[]};
      const last = JSON.stringify(body.messages.at(-1));
      const trigger = last.includes('tool_result') ? undefined : /trigger_id\\+":\\+"([0-9a-f]{32})/.exec(last)?.[1];
      const call = trigger && body.tools?.some(tool=>tool.name==='orchestrator_route')
        ? {name:'orchestrator_route',input:{decisions:[{kind:'accept',trigger_id:trigger,title:'Local request',worktree_name:'local-request',acknowledgement:'On it.'}]}} : undefined;
      const event = (type:string, value:object) => `event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
      return new Response(event('message_start',{message:{usage:{input_tokens:10,output_tokens:0}}})+
        event('content_block_start',{index:0,content_block:call?{type:'tool_use',id:crypto.randomUUID(),name:call.name,input:{}}:{type:'text',text:''}})+
        event('content_block_delta',{index:0,delta:call?{type:'input_json_delta',partial_json:JSON.stringify(call.input)}:{type:'text_delta',text:'Done.'}})+
        event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:call?'tool_use':'end_turn'},usage:{output_tokens:4}})+event('message_stop',{}),{headers:{'content-type':'text/event-stream'}});
    }, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text())))});
  const api = nativeClient(() => runtime), base = `/v1/tenants/${tenantId('alpha')}/environments/default`;
  const key = 'pending-setup-executor-test';
  const panel = (path: string, method = 'GET', body?: unknown) => runtime.dispatchFetch(url('anonymous', `/v1/plugin-hooks/${tenantId('alpha')}/default/${encodeURIComponent(plugin.name)}/api/${path}`),
    {method, headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)} as never);
  try {
    await api.call('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
    const row = (await (await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    assert.equal((await runtime.dispatchFetch(url('alpha', base + '/native/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest, permissions: row.permissions})})).status, 200);
    const ns = entryNamespace(plugin.name, 'dsh-superagent');
    const form = (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === ns)!;
    await api.call('settings/update', {ns, patch: {managementKey: key}, expectedRevision: form.revision});
    let state = await panel('state');
    for (let attempt = 0; state.status !== 200 && attempt < 40; attempt++) {await new Promise(resolve => setTimeout(resolve, 100)); state = await panel('state');}
    assert.equal(state.status, 200, await state.clone().text());
    assert.equal((await state.json() as {setup: {problem: unknown}}).setup.problem, null);
    const read = async () => await (await panel('settings')).json() as {blocks: {executor: {revision: number; value: Record<string, unknown>}}};
    const current = (await read()).blocks.executor;
    const device = await panel('executors', 'POST', {name: 'Connected DSH'}); assert.equal(device.status, 200);
    const {id,pairingKey} = await device.json() as {id: string;pairingKey:string};
    const deviceCall=(operation:string,token:string,body?:unknown)=>runtime.dispatchFetch(url('anonymous',`/v1/plugin-hooks/${tenantId('alpha')}/default/${encodeURIComponent(plugin.name)}/executor/${id}/${operation}`),
      {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})} as never);
    const paired=await deviceCall('pair',pairingKey);assert.equal(paired.status,200);
    const {token}=await paired.json() as {token:string};
    const sync=(accepting:boolean)=>deviceCall('sync',token,{protocol:'weft-executor/1',accepting,projects:[{id:'internal',name:'Internal project'}],states:[]});
    assert.equal((await sync(false)).status,200);
    const value = {...current.value, executorId: id};
    const saved = await panel('settings/executor', 'PUT', {revision: current.revision, value});
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await saved.json(), {saved: true, revision: current.revision + 1, policy_changed: false, restarting: false, context_delivery: 'injected'});
    const next = (await read()).blocks.executor; assert.equal(next.value.executorId, id);
    const repeated = await panel('settings/executor', 'PUT', {revision: next.revision, value});
    assert.equal(repeated.status, 200); assert.equal((await repeated.json() as {restarting: boolean}).restarting, false);
    const request={requestId:crypto.randomUUID(),text:'Verify the local internal project.',executorId:id,projectId:'internal'};
    const submitted=await panel('requests','POST',request);assert.equal(submitted.status,200,await submitted.clone().text());
    const received=await submitted.json() as {triggerId:string;thread:string;result:string};assert.equal(received.result,'stored');
    const duplicate=await panel('requests','POST',request);assert.equal((await duplicate.json() as {result:string}).result,'duplicate');
    let commands: {projectId:string;ticketId:string;instructions:string}[]=[];
    for(let attempt=0;attempt<100&&!commands.length;attempt++){
      const reply=await sync(true);assert.equal(reply.status,200,await reply.clone().text());
      commands=(await reply.json() as {commands:typeof commands}).commands;
      if(!commands.length)await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(commands.length,1,'an authenticated request reaches local execution without any GitHub setup');
    assert.equal(commands[0]!.projectId,'internal');
    const followup=await panel(`requests/${request.requestId}/messages`,'POST',{requestId:crypto.randomUUID(),text:'Please include the regression check.'});
    assert.equal(followup.status,200);assert.equal((await followup.json() as {thread:string}).thread,received.thread);
    assert.equal(githubReads,0,'optional GitHub is never queried');
  } finally {await runtime.dispose();}
});
