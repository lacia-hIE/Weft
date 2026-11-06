import {test} from 'node:test'
import assert from 'node:assert/strict'
import {localSessionAddress} from '../plugins/superagent/src/client/computers.ts'

test('local task navigation uses the owner catalogue and native Session list instead of device URLs',async()=>{
  const originalFetch=globalThis.fetch,originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document')
  const executor=crypto.randomUUID(),session=`weft-${executor}-${'a'.repeat(32)}`,requests:string[]=[]
  let available=true
  Object.defineProperty(globalThis,'document',{configurable:true,value:{baseURI:'https://weft.example/v1/tenants/owner/environments/cloud/native/'}})
  globalThis.fetch=async(input,init)=>{
    const address=String(input);requests.push(address);assert.equal(init?.credentials,'same-origin')
    if(address.endsWith('/environments'))return Response.json({environments:[{id:'computer-a',name:'Computer',kind:'local',local:{online:true}},{id:'offline',kind:'local',local:{online:false}},{id:'cloud',kind:'cloud'}]})
    if(address.endsWith('/api/weft-executor'))return Response.json({ready:true,endpoint:`https://weft.example/v1/plugin-hooks/owner/cloud/%40weft%2Fdsh-superagent/executor/${executor}`})
    assert.ok(address.endsWith('/computer-a/local/web/api/session/list'))
    const body=JSON.parse(String(init?.body));assert.equal(body.method,'session/list')
    return Response.json({result:{ok:true,value:{items:available?[{sessionId:session}]:[]}}})
  }
  try{
    assert.equal(await localSessionAddress(executor,session),`https://weft.example/v1/tenants/owner/environments/computer-a/local/web/?weft-session=${session}`)
    assert.equal(requests.length,3)
    assert.equal(await localSessionAddress(crypto.randomUUID(),session),undefined,'another computer cannot claim this Session')
    assert.equal(requests.length,3)
    available=false;assert.equal(await localSessionAddress(executor,session),undefined,'a removed native Session has no navigation link')
  }finally{
    globalThis.fetch=originalFetch
    if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else Reflect.deleteProperty(globalThis,'document')
  }
})
