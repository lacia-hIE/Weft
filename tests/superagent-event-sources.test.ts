import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../plugins/superagent/src/app/store.ts'
import {RepositoryEvents, feedEntries} from '../plugins/superagent/src/sources/repository-events.ts'
import {sourceHealth} from '../plugins/superagent/src/app/views/sources.ts'
import {SourceRegistry} from '../plugins/superagent/src/sources/registry.ts'
import {memorySql} from './helpers/superagent-sql.ts'
import type {Trigger} from '../plugins/superagent/src/core/index.ts'
import type {SourceContext} from '../plugins/superagent/src/sources/host.ts'

function harness() {
  const sql=memorySql(), store=new Store(sql), sources=new SourceRegistry(()=>store.settings()), received:Trigger[]=[], reports=new Map<string,unknown>(), secrets:Record<string,string>={}
  const events=new RepositoryEvents({store,secret:(id,name)=>secrets[`${id}-${name}`]??'',context:id=>({
    config:()=>sources.instance(id)?.enabled?sources.instance(id)!.config:undefined,
    receive:(trigger:Trigger)=>{received.push(trigger);store.triggers.save(trigger);return 'stored'},report:(name:string,value:unknown)=>reports.set(name,value),
  } as unknown as SourceContext)})
  for (const type of ['github-webhook','gitlab','feed'] as const) sources.registerFactory(type,id=>events.kind(id,type))
  const add=(type:'github-webhook'|'gitlab'|'feed',config:Record<string,unknown>={})=>{
    const id=sources.create(type), current=store.settings(), parsed=sources.kind(id)!.schema.parse(config)
    store.saveSettings({...current,sources:{...current.sources,[id]:{kind:type,name:type,enabled:true,config:parsed}}})
    return id
  }
  return {sql,store,sources,received,reports,secrets,events,add}
}
test('multiple repository Sources retain independent identities and verify scope before normalizing events',async()=>{
  const h=harness()
  try {
    const first=h.add('github-webhook',{repository:'team/a',mention:'agent'}), second=h.add('github-webhook',{repository:'team/b'}), gitlab=h.add('gitlab',{repository:'team/internal'})
    const payload={repository:{full_name:'team/a'},sender:{login:'alice',type:'User'},action:'opened',issue:{number:7,title:'Fix',body:'@agent please fix',updated_at:'2026-11-04T01:00:00Z',html_url:'https://github.com/team/a/issues/7'}}
    await h.events.webhook(first,'github-webhook',payload,'delivery')
    await h.events.webhook(first,'github-webhook',payload,'delivery')
    assert.equal(h.received.length,1);assert.equal(h.received[0]!.source,first);assert.equal(h.received[0]!.addressed,'mention')
    const health=sourceHealth(h.sources,h.sources.instance(first)!,{[`${first}:webhook`]:{state:'ready',detail:'Received'},[`${first}:feed`]:{state:'paused',detail:'Off'}})
    assert.equal(health.health.length,1);assert.equal(health.health[0]!.state,'ready','a disabled subscription does not pause a working webhook')
    await assert.rejects(h.events.webhook(second,'github-webhook',payload,'delivery'),/does not match/)
    await h.events.webhook(gitlab,'gitlab',{project:{path_with_namespace:'team/internal'},user:{username:'alice'},object_kind:'issue',object_attributes:{iid:7,title:'Internal task',description:'Investigate',action:'open',updated_at:'2026-11-04T01:00:00Z',url:'https://gitlab.com/team/internal/-/issues/7'}},'gitlab-delivery')
    assert.notEqual(h.received[0]!.threads[0]!.source,h.received[1]!.threads[0]!.source)
    const restored=new SourceRegistry(()=>h.store.settings());restored.registerFactory('github-webhook',id=>h.events.kind(id,'github-webhook'))
    assert.equal(restored.instance(first)?.kind,'github-webhook');assert.equal(restored.instance(second)?.config.repository,'team/b')
    assert.equal(JSON.stringify(h.store.settings()).includes('sourceSecrets'),false)
    const old=h.store.settings();h.store.saveSettings({...old,sources:{...old.sources,[first]:{...old.sources[first]!,archived:true}}})
    await assert.rejects(h.events.webhook(first,'github-webhook',payload,'later'),/disabled/)
  } finally {h.sql.close()}
})

test('Atom polling establishes a baseline, sends only changes, preserves conditional validators and redacts private URLs',async t=>{
  const h=harness();let now=Date.now(),version=1,calls=0
  t.mock.method(Date,'now',()=>now)
  const xml=(number:number)=>`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>issue-7</id><title>Task ${number}</title><updated>2026-11-04T01:00:0${number}Z</updated><link href="https://gitlab.example/team/a/-/issues/7"/><summary>Original context</summary></entry></feed>`
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{calls++;if(calls===2)assert.equal(new Headers(init.headers).get('if-none-match'),'"first"');return new Response(xml(version),{headers:{etag:'"first"'}})})
  try {
    const id=h.add('feed',{intervalSeconds:60}),other=h.add('feed');h.secrets[`${id}-feed`]='https://gitlab.example/feed.atom?feed_token=PRIVATE'
    await h.events.poll(id,'feed',new AbortController().signal)
    assert.equal(h.received.length,0,'first subscription never turns old entries into tasks')
    version=2;now+=61_000;await h.events.poll(id,'feed',new AbortController().signal)
    assert.equal(h.received.length,1);assert.equal(h.received[0]!.human,false);assert.equal(h.received[0]!.actor.id,'')
    now+=61_000;await h.events.poll(id,'feed',new AbortController().signal);assert.equal(h.received.length,1)
    await h.events.poll(other,'feed',new AbortController().signal)
    assert.equal((h.reports.get(`${other}:feed`) as {state:string}).state,'error');assert.equal((h.reports.get(`${id}:feed`) as {state:string}).state,'ready')
    assert.equal(JSON.stringify([...h.reports.values()]).includes('PRIVATE'),false)
    h.secrets[`${id}-feed`]='https://gitlab.example/another.atom?feed_token=CHANGED';now+=61_000
    await h.events.poll(id,'feed',new AbortController().signal);assert.equal(h.received.length,1,'changing a subscription creates a new baseline')
  } finally {h.sql.close()}
})

test('feed parser admits RSS and Atom, rejects other XML, and never expands external entities',()=>{
  assert.equal(feedEntries('<rss><channel><item><guid>x</guid><title>News</title><link>https://example.com/x</link></item></channel></rss>')[0]!.title,'News')
  assert.throws(()=>feedEntries('<html>not a feed</html>'),/Expected/)
  assert.throws(()=>feedEntries('<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel><item><guid>one</guid><title>&secret;</title></item></channel></rss>'),/External entities are not supported|Invalid RSS/)
})

test('verified mentions have account boundaries and Source context uses its own scoped credentials',async t=>{
  const h=harness()
  try {
    const id=h.add('gitlab',{repository:'team/private',mention:'agent'});h.secrets[`${id}-token`]='LOCAL_SOURCE_TOKEN'
    const payload={project:{path_with_namespace:'team/private'},user:{username:'alice'},object_kind:'note',object_attributes:{id:19,noteable_iid:7,noteable_type:'Issue',note:'@agent-extra',updated_at:'2026-11-04T01:00:00Z',url:'https://gitlab.com/team/private/-/issues/7#note_19'}}
    await h.events.webhook(id,'gitlab',payload,'one');assert.equal(h.received[0]!.addressed,undefined)
    await h.events.webhook(id,'gitlab',{...payload,object_attributes:{...payload.object_attributes,note:'@agent please verify',updated_at:'2026-11-04T01:00:01Z'}},'two')
    assert.equal(h.received[1]!.addressed,'mention')
    t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
      assert.equal(String(url),'https://gitlab.com/api/v4/projects/team%2Fprivate/issues/7/notes?per_page=50&page=1')
      assert.equal(new Headers(init.headers).get('private-token'),'LOCAL_SOURCE_TOKEN')
      return Response.json([{id:19,body:'Discussion context',author:{username:'alice'},created_at:'2026-11-04T01:00:00Z'}])
    })
    const context=h.events.kind(id,'gitlab').threadContext!
    const result=await context.read(h.received[1]!,'thread',undefined,h.sources.instance(id)!.config as never)
    assert.equal(result.messages[0]!.text,'Discussion context')
    await assert.rejects(context.read({...h.received[1]!,source:'other'},'thread',undefined,{} as never),/unavailable/)
  } finally {h.sql.close()}
})

test('Source reply retry recovers an uncertain delivery without posting a duplicate',async t=>{
  const h=harness();let posts=0
  try {
    const id=h.add('github-webhook',{repository:'team/private',reply:true});h.secrets[`${id}-token`]='SOURCE_TOKEN'
    const send=h.events.kind(id,'github-webhook').channel!.send
    const message={id:'reply-123',kind:'reply',channel:{source:id,thread:'discussion',address:{path:'issues/7/comments',url:'https://github.com/team/private/issues/7'}},text:'Verified locally'} as Parameters<typeof send>[0]
    t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
      assert.match(String(url),/^https:\/\/api.github.com\/repos\/team\/private\/issues\/7\/comments/)
      if(init.method==='POST'){posts++;throw new Error('Connection lost after submission')}
      return Response.json([{body:'Verified locally\n<!-- weft:reply-123 -->'}])
    })
    await assert.rejects(send(message),/Connection lost/)
    assert.equal(await send(message),'sent');assert.equal(await send(message),'sent');assert.equal(posts,1)
    assert.equal(await send({...message,id:'wrong-scope',channel:{...message.channel,address:{path:'issues/7/comments',url:'https://github.com/team/other/issues/7'}}}),'gone')
  } finally {h.sql.close()}
})

test('IM connections of the same type isolate identities, labels, reply targets and parent references',async()=>{
  const {feishuKind}=await import('../plugins/superagent/src/sources/feishu.ts')
  const {imTrigger}=await import('../plugins/superagent/src/sources/im.ts')
  const sent:{bot:string;argument:unknown}[]=[],sql=memorySql(),store=new Store(sql),sources=new SourceRegistry(()=>store.settings())
  const im={bots:async()=>[{bot:'feishu_a',kind:'feishu',name:'Team A'},{bot:'feishu_b',kind:'feishu',name:'Team B'}],call:async(bot:string,_operation:string,argument:unknown)=>{sent.push({bot,argument});return {messages:[]}}}
  sources.registerFactory('feishu',id=>feishuKind(im as never,id))
  try {
    const a=sources.create('feishu'),b=sources.create('feishu')
    store.saveSettings({...store.settings(),sources:{[a]:{kind:'feishu',name:'Team A',enabled:true,config:{bot:'feishu_a'}},[b]:{kind:'feishu',name:'Team B',enabled:true,config:{bot:'feishu_b'}}}})
    const event={kind:'feishu',messageId:'om_shared',chatId:'oc_chat',direct:false,sender:{id:'ou_alice',bot:false},mentioned:true,text:'Fix it',at:new Date().toISOString(),rootId:'om_root',parentId:'om_parent',target:{chatId:'oc_chat'}}
    const first=imTrigger(a,'feishu_a',event),second=imTrigger(b,'feishu_b',event)
    assert.notEqual(first.id,second.id);assert.notEqual(first.threads[0]!.source,second.threads[0]!.source)
    assert.notEqual(sources.repliesTo(first),sources.repliesTo(second))
    await sources.kind(a)!.channel!.send({id:'reply-a',kind:'reply',channel:first.channel!,text:'A'})
    assert.equal(sent[0]!.bot,'feishu_a');assert.equal((sent[0]!.argument as {target:{inThread:boolean}}).target.inThread,true)
    assert.equal(sources.scope({source:b,meta:first.meta}).listened,false)
    await assert.rejects(sources.kind(b)!.threadContext!.read(first,'thread',undefined,sources.instance(b)!.config),/no longer belongs/)
    const labels:Record<string,unknown>={}
    await sources.kind(a)!.refreshLabels!({sources,context:()=>({state:{set:(key:string,value:unknown)=>{labels[key]=value}}})} as never)
    assert.equal(JSON.stringify(labels).includes('feishu_a'),true);assert.equal(Object.keys(labels)[0]!.includes(a),true)
    const restored=new SourceRegistry(()=>store.settings());restored.registerFactory('feishu',id=>feishuKind(im as never,id));assert.equal(restored.instance(b)?.name,'Team B')
  } finally {sql.close()}
})

test('assessment mode follows each Source and removing a Source invalidates pending policy versions',async()=>{
  const {settingsPolicy,sourceMode,policyVersion,assessmentOutcome}=await import('../plugins/superagent/src/policy.ts')
  const h=harness()
  try {
    const a=h.add('feed'),b=h.add('feed'),base=h.store.settings()
    const settings={...base,eval:{...base.eval,mode:'off' as const},policy:{...base.policy,sources:{[a]:{allowed:[],admission:{activity:{unlistedUnaddressed:'inferred' as const}},mode:'auto' as const},[b]:{allowed:[],admission:{activity:{unlistedUnaddressed:'inferred' as const}},mode:'observe' as const}}}}
    h.store.saveSettings(settings)
    assert.equal(sourceMode(settings,a),'auto');assert.equal(sourceMode(settings,b),'observe');assert.equal(sourceMode(settings,'other'),'off')
    const policy=settingsPolicy(settings,h.sources),trigger=(id:string):Trigger=>({id,source:id,threads:[{source:id,id:'discussion'}],actor:{source:id,id:''},human:false,at:new Date().toISOString(),text:'Specified task',meta:{}})
    const thread={subscriptions:[]} as never
    assert.equal(policy.gate(trigger(a),thread,[]).admissible,true)
    assert.equal(policy.admitsInferred([settings.policy.rules[0]!.id],a),true);assert.equal(policy.admitsInferred([settings.policy.rules[0]!.id],b),false)
    const result={decision:'accept' as const,title:'Typo',scope:'Fix',reason:'Requested',intent_evidence:'Exact copy',worktree_name:'fix-copy',direction:{implementation_requested:true,target_basis:'specified',requires_design_decision:false,evidence:'Settled'},rule_assessments:settings.policy.rules.map((rule,index)=>({rule_id:rule.id,matched:index===0,reason:'Copy fix'}))}
    assert.equal(assessmentOutcome(result,settings,'inferred',a).kind,'accept');assert.equal(assessmentOutcome(result,settings,'inferred',b).kind,'ignore')
    const {Engine}=await import('../plugins/superagent/src/core/index.ts')
    const engine=new Engine({repo:h.store,scope:h.sources,policy:()=>settingsPolicy(h.store.settings(),h.sources),assessor:{request(){}},executor:{start(){},deliver(){},stop(){}},outbox:{send(){},withdraw(){},status:()=> 'sent'}})
    const accept={kind:'accept' as const,title:'Specified copy fix',scope:'Exact text replacement',reason:'Requested',rules:[settings.policy.rules[0]!.id],name:'fix-copy'}
    engine.receive(trigger(a));engine.evaluateDue();assert.equal(engine.decide(a,accept).kind,'accept','the Engine uses the Source override even when the global default is off')
    engine.receive(trigger(b));engine.evaluateDue();assert.throws(()=>engine.decide(b,accept),/explicit|Explicit/,'an observed Source cannot be accepted automatically')

    const removed={...settings,sources:{...settings.sources,[a]:{...settings.sources[a]!,enabled:false,archived:true}}}
    assert.notEqual(policyVersion(settings),policyVersion(removed));assert.equal(h.sources.scope({source:a,meta:{}},removed).listened,false)
    const renamed={...settings,sources:{...settings.sources,[a]:{...settings.sources[a]!,name:'Renamed'}}};assert.equal(policyVersion(settings),policyVersion(renamed))
    const validated=h.sources.validatePolicy(settings.policy.sources);assert.equal(validated[a]!.mode,'auto')
  } finally {h.sql.close()}
})

test('optional GitHub setup is not a system problem and actual authentication failures remain Source-local',async()=>{
  const {overview}=await import('../plugins/superagent/src/app/views/overview.ts'),{SetupError}=await import('../plugins/superagent/src/setup.ts')
  const h=harness()
  try {
    const view={store:h.store,sources:h.sources,links:()=>({url:'',label:{zh:'',en:''}})}
    const pending=overview(view as never,{},'policy',{running:0,queued:0},new SetupError('agentTokenUnset').problem)
    assert.equal(pending.problems.some(problem=>problem.kind==='setup'||problem.kind==='source-error'),false)
    const rejected=overview(view as never,{},'policy',{running:0,queued:0},new SetupError('agentTokenRejected').problem)
    assert.equal(rejected.problems.some(problem=>problem.kind==='setup'),false)
    assert.equal(rejected.problems.some(problem=>problem.kind==='source-error'&&problem.source.id==='github'),true)
  } finally {h.sql.close()}
})
