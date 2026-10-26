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

test('Worker HTTP carrier preserves exact bytes, completion and singular GitHub header checks',async()=>{
  const server=new WorkerWebServer();
  server.register({kind:'exact',path:'/github',handler:async(raw,response)=>{
    const request=raw as {headersDistinct:Record<string,string[]>;complete:boolean;[Symbol.asyncIterator]():AsyncIterator<Uint8Array>};
    const res=response as {writeHead(code:number):void;end(value:string):void};assert.equal(request.complete,false);
    const bytes:Uint8Array[]=[];for await(const part of request)bytes.push(part);
    assert.equal(request.complete,true);assert.deepEqual(request.headersDistinct['x-github-delivery'],['one','two']);res.writeHead(202);res.end(new TextDecoder().decode(bytes[0]));
  }});
  const body='{"text":"你好"}';const response=await server.dispatch(new Request('https://example.com/github',{method:'POST',headers:{'x-github-delivery':'one,two'},body}));
  assert.equal(response.status,202);assert.equal(await response.text(),body);
});
