import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPrivateKey,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Response} from 'miniflare';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import type {RemoteEventDownlinkFrame} from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {entryNamespace,type Installation} from '../packages/package-install/src/contracts.ts';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

const plugin=JSON.parse(readFileSync('plugins/im/package.json','utf8')) as {name:string};
const secret='im-question-test-secret';let seed=secret;while(seed.length<32)seed+=seed;
const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed.slice(0,32))]),format:'der',type:'pkcs8'});

test('a real Worker IM conversation answers the native question without a Web client, and Web answers win over stale IM replies',{timeout:180_000},async()=>{
  const sent:string[]=[],modelBodies:string[]=[];
  const event=(type:string,value:object)=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
  const runtime=createRuntime(undefined,{packages:true,bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'fixture',DEEPSEEK_BASE_URL:'https://im-question.test/anthropic'},
    packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text()))),
    outbound:async request=>{
      const target=new URL(request.url);
      if(target.hostname==='bots.qq.com')return Response.json({access_token:'qq-token',expires_in:'7200'});
      if(target.hostname==='api.sgroup.qq.com'){const body=await request.json() as {content?:string};if(body.content)sent.push(body.content);return Response.json({id:'sent-'+sent.length});}
      if(target.hostname!=='im-question.test')return new Response('not found',{status:404});
      const body=JSON.stringify(await request.json());modelBodies.push(body);
      const tool=!body.includes('tool_result');
      const args={questions:[{id:'color',question:'Which color should I use?',options:[{label:'Red'},{label:'Blue'}]}]};
      return new Response(event('message_start',{message:{usage:{input_tokens:10,output_tokens:0}}})
        +event('content_block_start',{index:0,content_block:tool?{type:'tool_use',id:'ask-color',name:'ask_user_question',input:{}}:{type:'text',text:''}})
        +event('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'ANSWER_SEEN'}})
        +event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:3}})+event('message_stop',{}),{headers:{'content-type':'text/event-stream'}});
    }});
  const api=nativeClient(()=>runtime),tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/default`;
  const wait=async<T>(read:()=>T|undefined|Promise<T|undefined>,label:string):Promise<T>=>{for(const end=Date.now()+45_000;Date.now()<end;await delay(100)){const value=await read();if(value!==undefined)return value;}throw new Error(`${label}: ${JSON.stringify(sent)}`)};
  const configure=async(entry:string,patch:Record<string,unknown>)=>{
    const ns=entryNamespace(plugin.name,entry),form=(await api.call<SettingsDescribeValue>('settings/describe',{})).namespaces.find(row=>row.ns===ns)!;
    await api.call('settings/update',{ns,patch,expectedRevision:form.revision});
  };
  const qq=async(content:string)=>{
    const id=crypto.randomUUID(),body=JSON.stringify({op:0,id:'event-'+id,t:'C2C_MESSAGE_CREATE',d:{id,content,timestamp:new Date().toISOString(),author:{user_openid:'qq-user'}}});
    const timestamp=String(Math.floor(Date.now()/1000));
    const response=await runtime.dispatchFetch(url('anonymous',`/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(plugin.name)}/qq`),{method:'POST',headers:{'content-type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':sign(null,Buffer.from(timestamp+body),key).toString('hex')},body});
    assert.equal(response.status,200,await response.text());
  };
  let events:Awaited<ReturnType<typeof api.events>>|undefined;
  try{
    const offered=(await api.call<BundleInfo[]>('pluginManager/listBundles',{})).find(row=>row.name===plugin.name)!;
    await api.call('pluginManager/installBundle',{spec:offered.installTarget!.spec,options:{requestId:crypto.randomUUID()}});
    const row=(await(await runtime.dispatchFetch(url('alpha',base+'/native/package-installations'))).json() as {installations:Installation[]}).installations[0]!;
    assert.equal((await runtime.dispatchFetch(url('alpha',base+'/native/package-installations'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network:true,routes:true}})})).status,200);
    await configure('im-core',{webUrl:'https://weft.example'+base+'/native/'});
    await configure('im-qq',{enabled:true,managementKey:'fixture',appId:'1020',appSecret:secret,allowedSenders:['qq-user']});
    await qq('ASK_IM_QUESTION');
    const question=await wait(()=>sent.find(text=>text.includes('Which color should I use?')),'question must arrive before the turn ends');
    assert.match(question,/1\. Red/);assert.match(question,/2\. Blue/);assert.match(question,/https:\/\/weft.example.*weft-session=/);
    assert.equal(sent.includes('ANSWER_SEEN'),false);
    const code=question.match(/· ([a-f0-9]{12})/)![1];
    await qq('2');await wait(()=>sent.includes('ANSWER_SEEN')?true:undefined,'native tool answer resumes the same turn');
    assert.match(modelBodies.at(-1)!,/Blue/);
    const calls=modelBodies.length;await qq(`/answer ${code} 1`);await delay(500);assert.equal(modelBodies.length,calls,'duplicate answers never start another prompt');
    assert.match(sent.at(-1)!,/已处理或已取消/);
    // A background plugin remains an answerer when an unrelated Web client delegates its waterfall.
    events=await api.events();const ready=await events.next();assert.equal(ready.type,'ready');if(ready.type!=='ready')throw new Error('ready');
    await qq('/new');await qq('ASK_SECOND_QUESTION');
    let invocation:RemoteEventDownlinkFrame;do invocation=await events.next();while(invocation.type!=='waterfall');
    const second=await wait(()=>sent.find(text=>text.includes('Which color should I use?')&&!text.includes(code!)),'second question');
    const secondCode=second.match(/· ([a-f0-9]{12})/)![1];
    await api.call('$events/result',{clientId:ready.clientId,eventId:invocation.eventId,outcome:{kind:'result',value:{answers:[{id:'color',selected:['Red']}]}}});
    await wait(()=>sent.filter(text=>text==='ANSWER_SEEN').length===2?true:undefined,'Web answer resumes IM turn');
    await qq(`/answer ${secondCode} 2`);assert.match(sent.at(-1)!,/已处理或已取消/);
  }finally{await events?.close();await runtime.dispose();}
});
