import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Response,type V4FetchHandler} from 'miniflare';
import {createRuntime} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

for(const redirect of [false,true])test(`rc.3 official model discovery uses the scoped credential and refuses redirects (${redirect})`,{timeout:90_000},async()=>{
  const requests:string[]=[];
  const outbound:V4FetchHandler=async request=>{
    requests.push(request.url);assert.equal(request.url,'https://api.deepseek.com/models');assert.equal(request.method,'GET');assert.equal(request.headers.get('x-api-key'),'model-listing-fixture');
    if(redirect)return new Response(null,{status:302,headers:{location:'https://untrusted.invalid/models'}});
    const capabilities={input_modalities:['text'],output_modalities:['text'],api_capabilities:{anthropic_messages:{}}};
    return Response.json({data:[{id:'deepseek-flash',name:'Listed Flash',...capabilities},{id:'deepseek-v4-pro',...capabilities,client_requirements:{'deepseek-harness':{min_version:'99.0.0'}}}]});
  };
  const runtime=createRuntime(undefined,{browser:true,bindings:{MODEL_BACKEND:'deepseek',DEEPSEEK_API_KEY:'model-listing-fixture',DEEPSEEK_BASE_URL:'https://api.deepseek.com/anthropic'},outbound});
  try{
    const api=nativeClient(()=>runtime);
    const catalog=await api.call<{groups:{models:{id:string}[]}[]}>('session/modelCatalog',{});
    assert.ok(catalog.groups.flatMap(group=>group.models).some(model=>model.id==='deepseek-flash'));
    if(!redirect)assert.equal(catalog.groups.flatMap(group=>group.models).some(model=>model.id==='deepseek-v4-pro'),false);
    assert.ok(requests.length>0);assert.ok(requests.every(url=>url==='https://api.deepseek.com/models'));
  }finally{await runtime.dispose();}
});
