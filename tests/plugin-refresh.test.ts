import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RefreshQueue} from '../packages/plugin-registry/src/refresh.ts';

test('plugin notification bursts share reads and obsolete grants cannot activate a client', {timeout:5000}, async()=>{
  const first=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),applied=Promise.withResolvers<void>();
  let approved=true, reads=0, active=0, peak=0;
  const accepted:boolean[]=[];
  const queue=new RefreshQueue(async current=>{
    const value=approved;
    peak=Math.max(peak,++active);
    if(++reads===1){started.resolve();await first.promise;}
    if(current()){accepted.push(value);applied.resolve();}
    active--;
  },error=>{throw error;});
  try{
    for(let i=0;i<30;i++)queue.refresh();
    await started.promise;
    assert.equal(reads,1);
    approved=false;
    for(let i=0;i<30;i++)queue.refresh();
    first.resolve();await applied.promise;
    assert.equal(reads,2);assert.equal(peak,1);assert.deepEqual(accepted,[false]);
  }finally{first.resolve();await queue.close();}
});

test('a failed refresh accepts the next notification and disposal suppresses late results', {timeout:5000}, async()=>{
  const failed=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let reads=0, applied=0, errors=0;
  const queue=new RefreshQueue(async current=>{
    if(++reads===1)throw new Error('temporary read failure');
    started.resolve();await release.promise;
    if(current())applied++;
  },()=>{errors++;failed.resolve();});
  queue.refresh();await failed.promise;
  queue.refresh();await started.promise;
  const closing=queue.close();release.resolve();await closing;
  queue.refresh();await Promise.resolve();
  assert.equal(reads,2);assert.equal(errors,1);assert.equal(applied,0);
});
