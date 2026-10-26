import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error Published Node plugin is JavaScript.
import {createController} from '../packages/local-host-connector/controller.mjs';
// @ts-expect-error Published Node plugin is JavaScript.
import {apply} from '../packages/local-host-connector/index.mjs';

test('older Hosts without release identity report an upgrade instruction before starting a connection',async()=>{
  for(const graph of [{entries:[]},undefined,{release:{version:'0.1.7-rc.2'}}]){
    await assert.rejects(apply({clientModules:{graph:()=>graph}}),error=>{
      assert.ok(error instanceof Error);assert.equal(error.name,'Error');
      assert.match(error.message,/supports DSH 0\.2\.1-rc\.2, 0\.2\.1-rc\.3/);
      assert.match(error.message,/npm install -g @deepseek-ai\/dsh@0\.2\.1-rc\.3/);
      return true;
    });
  }
});

test('native settings can pair a fresh plugin, retain its private token and reconnect without overlapping lifecycles',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'weft-connector-')),file=join(directory,'connection.json');
  const endpoint='https://weft.example/v1/local-hosts/tenant/local',key='a'.repeat(64),token='b'.repeat(64);
  let active=0;
  const connect=({save,onStatus}: {save:(settings:object)=>Promise<void>;onStatus:(state:string)=>void})=>{
    assert.equal(++active,1);onStatus('connected');
    const saved=save({endpoint,token});return async()=>{await saved;active--;};
  };
  const options={file,origin:'http://127.0.0.1:1234',authorize:async()=>'',version:'0.2.1-rc.3',connect};
  let controller=createController(options);
  try{
    await controller.load();assert.equal(controller.snapshot().state,'unpaired');
    await assert.rejects(controller.pair(JSON.stringify({endpoint:'http://untrusted.invalid',pairingKey:key})));
    await controller.pair(Buffer.from(JSON.stringify({endpoint,pairingKey:key})).toString('base64url'));
    assert.equal(controller.snapshot().state,'connected');assert.equal(JSON.stringify(controller.snapshot()).includes(key),false);
    await Promise.all([controller.reconnect(),controller.reconnect()]);assert.equal(active,1);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{endpoint,token});assert.equal((await stat(file)).mode&0o777,0o600);
    await controller.disconnect();assert.equal(active,0);assert.equal(controller.snapshot().state,'stopped');
    await controller.close();controller=createController(options);await controller.load();assert.equal(active,1);
    assert.equal(JSON.stringify(controller.snapshot()).includes(token),false);
  }finally{await controller.close();assert.equal(active,0);await rm(directory,{recursive:true,force:true});}
});
