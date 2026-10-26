import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorkerWebServer} from '../packages/native-plugins/src/web-server.ts';

test('Worker HTTP routes retain exact/prefix matching, native disposal and bounded finite handlers', async () => {
  const server = new WorkerWebServer();
  const register = (path: string, text: string, kind: 'prefix' | 'exact' = 'exact') => server.register({kind,path,handler:(_req,res)=>{const reply=res as {writeHead(status:number,headers:object):void;end(text:string):void};reply.writeHead(202,{'content-type':'text/plain'});reply.end(text);}});
  const remove = register('/hooks','prefix','prefix'); register('/hooks/exact','exact');
  assert.equal(await (await server.dispatch(new Request('https://example.com/hooks/child'))).text(),'prefix');
  assert.equal(await (await server.dispatch(new Request('https://example.com/hooks/exact'))).text(),'exact');
  assert.throws(()=>register('/hooks','duplicate'));
  remove();assert.equal((await server.dispatch(new Request('https://example.com/hooks/child'))).status,404);
  server.register({kind:'exact',path:'/resource',resource:async()=>new Response('resource')});
  assert.equal((await server.dispatch(new Request('https://example.com/resource',{method:'POST'}))).status,405);
  assert.equal(await (await server.dispatch(new Request('https://example.com/resource',{method:'HEAD'}))).text(),'');
  server.register({kind:'exact',path:'/unfinished',handler:()=>{}});
  await assert.rejects(server.dispatch(new Request('https://example.com/unfinished')),/must end/);
});
