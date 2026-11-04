import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../plugins/superagent/src/app/store.ts'
import {RepositoryEvents, feedEntries} from '../plugins/superagent/src/sources/repository-events.ts'
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
    const id=h.add('feed'),other=h.add('feed');h.secrets[`${id}-feed`]='https://gitlab.example/feed.atom?feed_token=PRIVATE'
    await h.events.poll(id,'feed',new AbortController().signal)
    assert.equal(h.received.length,0,'first subscription never turns old entries into tasks')
    version=2;now+=61_000;await h.events.poll(id,'feed',new AbortController().signal)
    assert.equal(h.received.length,1);assert.equal(h.received[0]!.human,false);assert.equal(h.received[0]!.actor.id,'')
    now+=61_000;await h.events.poll(id,'feed',new AbortController().signal);assert.equal(h.received.length,1)
    await h.events.poll(other,'feed',new AbortController().signal)
    assert.equal((h.reports.get(other) as {state:string}).state,'error');assert.equal((h.reports.get(id) as {state:string}).state,'ready')
    assert.equal(JSON.stringify([...h.reports.values()]).includes('PRIVATE'),false)
    h.secrets[`${id}-feed`]='https://gitlab.example/another.atom?feed_token=CHANGED';now+=61_000
    await h.events.poll(id,'feed',new AbortController().signal);assert.equal(h.received.length,1,'changing a subscription creates a new baseline')
  } finally {h.sql.close()}
})

test('feed parser admits RSS and Atom, rejects other XML, and never expands external entities',()=>{
  assert.equal(feedEntries('<rss><channel><item><guid>x</guid><title>News</title><link>https://example.com/x</link></item></channel></rss>')[0]!.title,'News')
  assert.throws(()=>feedEntries('<html>not a feed</html>'),/Expected/)
  const parsed=feedEntries('<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel><item><guid>one</guid><title>&secret;</title></item></channel></rss>')
  assert.doesNotMatch(parsed[0]!.title,/root:/)
})
