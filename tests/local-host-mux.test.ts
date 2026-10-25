import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MuxChannel} from '../packages/local-host-connector/mux.mjs';

test('fragmented Mux preserves Unicode and order across concurrent browser streams',async()=>{
  const delivered:Record<string,string[]>={};let frames=0;
  const failure=(_id:string,error:Error)=>{throw error;};
  let sender:MuxChannel,receiver:MuxChannel;
  sender=new MuxChannel(frame=>{frames++;assert.ok(JSON.stringify(frame).length<50_000);queueMicrotask(()=>receiver.handle(frame as Parameters<MuxChannel['handle']>[0]));},()=>{},failure);
  receiver=new MuxChannel(frame=>queueMicrotask(()=>sender.handle(frame as Parameters<MuxChannel['handle']>[0])),(id,text)=>{(delivered[id]??=[]).push(text);},failure);
  try{
    const large='中文🙂'.repeat(550_000);
    await Promise.all([sender.send('one',large),sender.send('one','after snapshot'),sender.send('two','another tab')]);
    assert.ok(frames>100);assert.deepEqual(delivered.one,[large,'after snapshot']);assert.deepEqual(delivered.two,['another tab']);
    for(let index=0;index<20;index++)await sender.send('one',String(index));
    assert.deepEqual(delivered.one?.slice(2),Array.from({length:20},(_,index)=>String(index)));
    await Promise.all(Array.from({length:400},(_,index)=>sender.send('typing',String(index))));
    assert.deepEqual(delivered.typing,Array.from({length:400},(_,index)=>String(index)));
  }finally{sender.close();receiver.close();}
});

test('a slow consumer stops acknowledgements and only its own stream times out',async()=>{
  const failures:string[]=[],messages:string[]=[];let sender:MuxChannel,receiver:MuxChannel,release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  sender=new MuxChannel(frame=>queueMicrotask(()=>receiver.handle(frame as Parameters<MuxChannel['handle']>[0])),()=>{},id=>failures.push(id),{timeoutMs:50});
  receiver=new MuxChannel(frame=>queueMicrotask(()=>sender.handle(frame as Parameters<MuxChannel['handle']>[0])),async(id,text)=>{if(id==='slow')await blocked;else messages.push(text);},id=>failures.push(id),{timeoutMs:50});
  try{
    const slow=assert.rejects(sender.send('slow','blocked message'),/timed out/);
    await sender.send('healthy','keep working');await slow;
    await sender.send('healthy','still working');assert.deepEqual(messages,['keep working','still working']);assert.ok(failures.every(id=>id==='slow'));
  }finally{release();sender.close();receiver.close();}
});

test('invalid fragments and queue budgets close only the offending stream and release buffered bytes',async()=>{
  const errors:string[]=[];
  const channel=new MuxChannel(()=>{},()=>{},id=>errors.push(id),{maxBufferedBytes:10,maxMessageBytes:10});
  try{
    channel.handle({type:'ws-fragment',id:'bad',message:'m',seq:1,body:'',end:true});assert.deepEqual(errors,['bad']);
    const waiting=assert.rejects(channel.send('queued','12345678'),/closed/);
    await assert.rejects(channel.send('overflow','1234'),/buffer limit/);channel.drop('queued');await waiting;
    const clean=assert.rejects(channel.send('clean','1234567890'),/closed/);channel.drop('clean');await clean;
    await assert.rejects(channel.send('oversized','12345678901'),/message limit/);
  }finally{channel.close();}
});
