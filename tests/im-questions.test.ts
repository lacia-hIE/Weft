import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['plugins/im/src/questions.js'],bundle:true,platform:'node',format:'esm',write:false});
const {ImQuestions,parseQuestionAnswer}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles![0]!.text).toString('base64'));
const host=await build({entryPoints:['packages/control-plane/src/native-events.ts'],bundle:true,platform:'node',format:'esm',write:false,tsconfig:'.generated/upstream.source.tsconfig.json'});
const {NativeEventHub}=await import('data:text/javascript;base64,'+Buffer.from(host.outputFiles![0]!.text).toString('base64'));
const questions=[{id:'color',question:'Which color?',options:[{label:'Red'},{label:'Blue'}]}];

test('native question settlement admits one structured answer, cancels Web deliveries and excludes approval requests',async()=>{
  const changed:string[]=[],hub=new NativeEventHub((id:string)=>changed.push(id)),abort=new AbortController();
  const stream=hub.open(abort.signal)[Symbol.asyncIterator]();
  const ready=(await stream.next()).value as any;
  const pending=hub.waterfall('question-1','user-questions/request','session-a',{questions});
  assert.equal(hub.questions('session-b').length,0);
  assert.equal(hub.answerQuestion('session-b','question-1',{answers:[{id:'color',selected:['Red']}]}),false);
  assert.throws(()=>hub.answerQuestion('session-a','question-1',{answers:[{id:'color',selected:['Unlisted']}]}));
  assert.equal(hub.questions('session-a').length,1);
  assert.equal((await stream.next()).value?.type,'waterfall');
  assert.equal(hub.answerQuestion('session-a','question-1',{answers:[{id:'color',selected:['Blue']}]}),true);
  assert.deepEqual(await pending,{kind:'result',value:{answers:[{id:'color',selected:['Blue']}]}});
  assert.equal((await stream.next()).value?.type,'cancel');
  hub.result({clientId:ready.clientId,eventId:'question-1',outcome:{kind:'result',value:{answers:[]}}} as any);
  assert.equal(hub.answerQuestion('session-a','question-1',{answers:[]}),false);
  assert.deepEqual(changed,['session-a','session-a']);
  const approval=hub.waterfall('permission','user-questions/request','session-a',{questions:[{id:'grant',question:'Allow?',intent:{kind:'approval',approve:'Yes',reject:'No'},options:[{label:'Yes'},{label:'No'}]}]},true);
  assert.deepEqual(hub.questions('session-a'),[]);
  assert.equal(hub.answerQuestion('session-a','permission',{answers:[{id:'grant',selected:['Yes']}]}),false);
  await stream.next();hub.result({clientId:ready.clientId,eventId:'permission',outcome:{kind:'next'}} as any);
  assert.deepEqual(await approval,{kind:'next'},'an ordinary question watcher cannot hold an unanswered permission request');
  assert.deepEqual(changed,['session-a','session-a']);abort.abort();await stream.return?.();
});

test('a registered question watcher keeps a request answerable after a Web client delegates it',async()=>{
  const hub=new NativeEventHub(),abort=new AbortController(),stream=hub.open(abort.signal)[Symbol.asyncIterator]();
  const ready=(await stream.next()).value as any,pending=hub.waterfall('held','user-questions/request','session',{questions},true);
  await stream.next();hub.result({clientId:ready.clientId,eventId:'held',outcome:{kind:'next'}} as any);
  assert.equal(hub.questions('session').length,1);
  assert.equal(hub.answerQuestion('session','held',{answers:[{id:'color',selected:['Red']}]}),true);
  await pending;abort.abort();await stream.return?.();
});

function table(initial: [string,any][]=[]){const rows=new Map(initial);return {get:(key:string)=>rows.get(key),entries:()=>rows.entries(),async put(key:string,value:any){rows.set(key,value)},async delete(key:string){rows.delete(key)},async update(key:string,fn:(row:any)=>any){const value=fn(rows.get(key));rows.set(key,value);return value}};}
function fixture(){
  const sent:{text:string;target:any}[]=[],answers:any[]=[],records=table();
  let pending:any[]=[{requestId:'live-question',callId:'call-1',state:'open',questions}];
  const origins={'prompt-1':{sender:'alice',target:{chat:'group-a',messageId:'origin'},group:true}};
  const conversations=table([['bot:group-a',{sessionId:'session-a',channel:'bot',pending:['prompt-1'],origins}]]);
  let events:any[]=[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user',rpcId:'prompt-1'}}},
    {type:'user/message',data:{source:{kind:'runtime-context'}}},{type:'user/message',data:{source:{kind:'time-context'}}},
    {type:'tool/call',data:{name:'ask_user_question',callId:'call-1'}}];
  const bridge:any={closed:false,config:{webUrl:'https://weft.test/v1/tenants/owner/environments/default/native/'},channels:new Map([['bot',{}]]),conversations,
    ctx:{sessionController:{questions:async()=>pending,page:async()=>({records:events.map(event=>({event}))}),answerQuestion:async(input:any)=>{answers.push(input);pending=[];return true}}},
    async send(_channel:string,target:any,text:string){sent.push({target,text});return ['sent-'+sent.length]},async stopActivity(){},async updateCard(){},startActivity(){},follow(){}};
  const service=new ImQuestions(bridge,records);
  const message=(text:string,sender='alice',extra={})=>({channel:'bot',conversation:'group-a',sender,text,target:{chat:'group-a'},...extra});
  return {service,bridge,sent,answers,records,message,setPending(value:any[]){pending=value},setEvents(value:any[]){events=value}};
}

test('IM questions bind the originating chat and person, preserve partial answers and submit the original request once',async()=>{
  const f=fixture();await f.service.sync('session-a');await f.service.sync('session-a');
  assert.equal(f.sent.length,1);assert.match(f.sent[0]!.text,/Which color/);assert.match(f.sent[0]!.text,/weft-session=session-a/);
  const code=f.sent[0]!.text.match(/· ([a-f0-9]{12})/)![1];
  await f.service.receive(f.message('/answer '+code+' 1','mallory'));
  assert.equal(f.answers.length,0);assert.match(f.sent.at(-1)!.text,/发起这次请求的人/);
  await f.service.receive(f.message('/answer '+code+' 2','alice',{conversation:'other-chat'}));assert.equal(f.answers.length,0);
  await f.service.receive(f.message('2','alice',{replyTo:'sent-1'}));
  assert.deepEqual(f.answers,[{sessionId:'session-a',requestId:'live-question',answer:{answers:[{id:'color',selected:['Blue']}]}}]);
  await f.service.receive(f.message('/answer '+code+' 1'));assert.equal(f.answers.length,1);
  assert.match(f.sent.at(-1)!.text,/已处理或已取消/);
});

test('IM continued questions use native late answers, while a Web answer and /new invalidate implicit replies',async()=>{
  const f=fixture();await f.service.sync('session-a');
  const row=[...f.records.entries()][0]![1];
  f.setPending([{requestId:'call-1',callId:'call-1',state:'continued',questions}]);
  await f.service.sync('session-a');assert.match(f.sent.at(-1)!.text,/仍可/);
  await f.service.receive(f.message('Red'));
  assert.equal(f.answers[0].requestId,'call-1');
  assert.ok(f.bridge.conversations.get('bot:group-a').pending.includes('question:call-1'));
  const web=fixture();await web.service.sync('session-a');web.setPending([]);
  web.setEvents([{type:'tool/result',data:{message:{toolCallId:'call-1'}}}]);
  await web.service.receive(web.message('/answer '+row.code+' 2'));assert.equal(web.answers.length,0);
  const fresh=fixture();await fresh.service.sync('session-a');
  await fresh.bridge.conversations.update('bot:group-a',(value:any)=>({...value,sessionId:'new-session'}));
  assert.equal(await fresh.service.receive(fresh.message('A new task')),false);
});

test('multi-question and multi-select answers retain native ids and option labels, and mixed turn provenance is not forwarded',async()=>{
  assert.deepEqual(parseQuestionAnswer(questions[0],'/skip'),{id:'color',selected:[]});
  assert.deepEqual(parseQuestionAnswer({...questions[0],multiSelect:true},'1, 2'),{id:'color',selected:['Red','Blue']});
  assert.throws(()=>parseQuestionAnswer(questions[0],'1,2'));
  const f=fixture();f.setPending([{requestId:'batch',callId:'call-1',state:'open',questions:[...questions,{id:'detail',question:'Any detail?'}]}]);
  await f.service.sync('session-a');await f.service.receive(f.message('1'));assert.equal(f.answers.length,0);
  await f.service.receive(f.message('Use the small version'));assert.deepEqual(f.answers[0].answer,{answers:[{id:'color',selected:['Red']},{id:'detail',selected:[],custom:'Use the small version'}]});
  const mixed=fixture();mixed.setEvents([{type:'turn/start'},{type:'user/message',data:{source:{kind:'user',rpcId:'prompt-1'}}},{type:'user/message',data:{source:{kind:'user',rpcId:'web-only'}}}]);
  await mixed.service.sync('session-a');assert.equal(mixed.sent.length,0);
});

test('plugin reload preserves a partial batch without resending, and a vanished foreground wait is not advertised as answerable',async()=>{
  const f=fixture();f.setPending([{requestId:'batch',callId:'call-1',state:'open',questions:[...questions,{id:'notes',question:'Any notes?'}]}]);
  await f.service.sync('session-a');await f.service.receive(f.message('1'));
  const count=f.sent.length,reloaded=new ImQuestions(f.bridge,f.records);
  await reloaded.sync('session-a');assert.equal(f.sent.length,count);
  await reloaded.receive(f.message('Keep it small'));assert.equal(f.answers[0].answer.answers[1].custom,'Keep it small');
  const stopped=fixture();await stopped.service.sync('session-a');stopped.setPending([]);
  const afterRestart=new ImQuestions(stopped.bridge,stopped.records);await afterRestart.receive(stopped.message('/questions'));
  assert.match(stopped.sent.at(-1)!.text,/没有等待/);assert.equal(afterRestart.waiting('bot:group-a'),false);
  assert.equal(await afterRestart.receive(stopped.message('A new task')),false);
});

test('a Host without the question capability keeps ordinary IM messages available',async()=>{
  const f=fixture();delete f.bridge.ctx.sessionController.questions;
  const service=new ImQuestions(f.bridge,f.records);await service.sync('session-a');
  assert.equal(await service.receive(f.message('An ordinary message')),false);
  assert.equal(await service.receive(f.message('/questions')),true);assert.match(f.sent.at(-1)!.text,/更新 Weft/);
});
