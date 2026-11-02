import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {packageModel} from './helpers/package-model.ts';
import {createRuntime,tenantId,url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';

test('a package commits across tables in its facet and scopes prompts and tools to the Sessions it manages',{timeout:180000},async()=>{
  const fixture=packageFixture({name:'@weft-fixture/managed',client:false,files:{'host.js':`
    import {defineTool} from '@deepseek-ai/dsh-tools';
    export const inject=['weftSql','weftManagedSessions','sessionController','tools','webServer'];
    export function apply(ctx){
      ctx.tools.register(defineTool({name:'package_save',description:'Scoped tool',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>({caller:ctx.sessionController.callerSessionId()})}));
      ctx.tools.register(defineTool({name:'package_open',description:'Unscoped tool',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>({})}));
      ctx.effect(()=>ctx.weftManagedSessions.scopeTools(['package_save']));
      const sql=ctx.weftSql;
      sql.exec('CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY)');sql.exec('CREATE TABLE IF NOT EXISTS b (id TEXT PRIMARY KEY)');
      const attempt=work=>{try{return {value:work()};}catch(error){return {error:String(error.message)};}};
      const count=table=>sql.exec('SELECT COUNT(*) AS n FROM '+table)[0].n;
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/sql',handler:(req,res)=>{
        const result={};
        sql.transaction(()=>{sql.exec("INSERT INTO a VALUES ('kept')");sql.exec("INSERT INTO b VALUES ('kept')");});
        result.committed=[count('a'),count('b')];
        result.rolledBack=attempt(()=>sql.transaction(()=>{sql.exec("INSERT INTO a VALUES ('lost')");sql.exec("INSERT INTO b VALUES ('lost')");throw new Error('abort');})).error;
        result.afterRollback=[count('a'),count('b')];
        sql.transaction(()=>{sql.exec("INSERT INTO a VALUES ('outer')");attempt(()=>sql.transaction(()=>{sql.exec("INSERT INTO b VALUES ('inner')");throw new Error('inner');}));});
        result.afterNested=[count('a'),count('b')];
        result.reserved=attempt(()=>sql.exec('DELETE FROM plugin_timers')).error;
        result.storage=attempt(()=>sql.exec('SELECT * FROM "weft_kv_units"')).error;
        result.asynchronous=attempt(()=>sql.transaction(async()=>{})).error;
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
      }}));
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/manage',handler:async(req,res)=>{
        const query=new URL(req.url,'http://host').searchParams,session=query.get('session');
        const result=await Promise.resolve().then(()=>query.get('release')?ctx.weftManagedSessions.release(session):ctx.weftManagedSessions.configure(session,{instructions:query.get('text')??'MANAGED_MARKER',tools:['package_save']})).then(()=>'ok',error=>String(error.message));
        res.writeHead(200);res.end(result);
      }}));
    }`}}),model=packageModel();
  const runtime=createRuntime(undefined,{packages:true,bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'fixture',DEEPSEEK_BASE_URL:'https://package-model.test/anthropic'},outbound:async(request,mf)=>new URL(request.url).hostname==='package-model.test'?model.outbound(request,mf):request.url===fixture.manifest.dist.tarball?new Response(fixture.bytes):Response.json(fixture.manifest),packageBuilder:async request=>Response.json(await buildPackage(JSON.parse(await request.text())))});
  const tenant=tenantId('alpha'),api=nativeClient(()=>runtime),base=`/v1/tenants/${tenant}/environments/default`;
  const operation=(body?:object)=>runtime.dispatchFetch(url('alpha',base+'/native/package-installations'),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const hook=(path:string)=>runtime.dispatchFetch(url('anonymous',`/v1/plugin-hooks/${tenant}/default/${encodeURIComponent(fixture.name)}${path}`));
  const turn=async(sessionId:string)=>{const follow=await api.follow(sessionId);await follow.next();try{await api.call('session/prompt',{request:{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'PLAIN '+crypto.randomUUID()}]}});for(;;){const frame=await follow.next();if(frame.type==='event'&&frame.event.type==='turn/end')break;}}finally{await follow.close();}};
  const lastRequest=()=>JSON.parse(model.observations.at(-1)!) as {system?:unknown;tools?:{name:string}[]};
  const offered=()=>(lastRequest().tools??[]).map(tool=>tool.name);
  try{
    await api.call('pluginManager/installBundle',{spec:`${fixture.name}@${fixture.version}`});
    const row=(await(await operation()).json() as {installations:Installation[]}).installations[0]!;
    assert.equal(row.hostScope,'environment');assert.equal(row.permissions.storage,true);assert.equal(row.permissions.sessions,true);
    assert.equal((await operation({operation:'approve',name:row.name,digest:row.digest,permissions:{...row.permissions,network:false}})).status,200);

    assert.deepEqual(await(await hook('/sql')).json(),{
      committed:[1,1],rolledBack:'abort',afterRollback:[1,1],afterNested:[2,1],
      reserved:'weftSql cannot address host-owned tables',storage:'weftSql cannot address host-owned tables',asynchronous:'A weftSql transaction must be synchronous',
    });

    for(const sessionId of ['managed-a','personal-b'])await api.call('session/create',{request:{sessionId}});
    assert.equal(await(await hook('/manage?session=managed-a')).text(),'ok');
    await turn('managed-a');
    assert.ok(offered().includes('package_save'),'the managed Session is offered its scoped tool');
    assert.ok(JSON.stringify(lastRequest().system).includes('MANAGED_MARKER'),'the instructions reach the system prompt');
    await turn('personal-b');
    assert.ok(!offered().includes('package_save'),'another Session is not offered the scoped tool');
    assert.ok(offered().includes('package_open'),'an unscoped tool stays available to every Session');
    assert.ok(!JSON.stringify(lastRequest().system).includes('MANAGED_MARKER'),'another Session does not receive the instructions');

    assert.equal(await(await hook('/manage?session=managed-a&text=MANAGED_SECOND')).text(),'ok');
    await turn('managed-a');
    assert.ok(model.observations.at(-1)!.includes('MANAGED_SECOND'),'changed instructions reach the next turn, which the native prompt appends to its history');

    assert.equal(await(await hook('/manage?session=managed-a&release=1')).text(),'ok');
    await turn('managed-a');
    assert.ok(!offered().includes('package_save'),'release withdraws the scoped tool before the next turn');

    assert.match(await(await hook('/manage?session=not-a-session')).text(),/outside this environment/);
  }finally{await runtime.dispose();}
});
