import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerTaskStore, type TaskRequest} from '../apps/web/src/official/worker-task-store.ts';
import type {JavaScriptStatus} from '../packages/workspace/src/javascript.ts';

test('cards share one Session read, fetch expanded details once, pause hidden and abort after unmount', async () => {
  const calls: string[] = [];
  let hidden = false, ended = false;
  const task: JavaScriptStatus = {id: crypto.randomUUID(), status: 'waiting', stdout: 'large output', stderr: '', pending: []};
  const request: TaskRequest = async (_session, operation, id, signal) => {
    calls.push(operation+':'+(id ?? '*'));
    await delay(5, undefined, {signal});
    return operation === 'list' ? {tasks: [{id: task.id, status: task.status, pending: []}]} : task;
  };
  const store = new WorkerTaskStore('session-a', request, () => hidden, () => {ended = true;});
  const stops = [store.subscribe(() => {}), store.subscribe(() => {}, task.id), store.subscribe(() => {}, task.id)];
  try {
    await delay(30);
    assert.deepEqual(calls, ['list:*']);
    stops.push(store.subscribe(() => {}, task.id, true), store.subscribe(() => {}, task.id, true));
    await delay(30);
    assert.deepEqual(calls, ['list:*', 'list:*', 'status:'+task.id]);
    assert.equal(store.getSnapshot().details.get(task.id)?.stdout, 'large output');
    hidden = true; store.refresh(false); await delay(20);
    assert.equal(calls.length, 3);
    hidden = false; store.refresh(false); await delay(30);
    assert.equal(calls.filter(call => call.startsWith('list')).length, 3);
    store.refresh(); await delay(2);
  } finally {for (const stop of stops) stop();}
  await delay(20); assert.equal(ended, true);
  assert.equal(store.getSnapshot().error, false);
});

test('shared cancellation keeps mutation errors until explicit refresh and never mixes Session stores', async () => {
  const task: JavaScriptStatus = {id: crypto.randomUUID(), status: 'waiting', stdout: '', stderr: '', pending: []};
  const request: TaskRequest = async (session, operation) => {
    if (operation === 'cancel') throw new Error('temporary failure');
    return {tasks: session === 'a' ? [task] : []};
  };
  const a = new WorkerTaskStore('a', request, () => false, () => {});
  const b = new WorkerTaskStore('b', request, () => false, () => {});
  const stops = [a.subscribe(() => {}), b.subscribe(() => {})];
  try {
    await delay(15); await a.cancel(task.id); await delay(15);
    assert.equal(a.getSnapshot().error, true); assert.equal(b.getSnapshot().error, false);
    assert.equal(b.getSnapshot().value?.tasks.length, 0);
    a.refresh(); await delay(15); assert.equal(a.getSnapshot().error, false);
  } finally {for (const stop of stops) stop();}
});

test('expanded task cards load in bounded parallel waves and reuse completed details', {timeout:5000},async()=>{
  const tasks=Array.from({length:7},()=>({id:crypto.randomUUID(),status:'completed' as const,stdout:'output',stderr:'',pending:[]}));
  const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),loaded=Promise.withResolvers<void>(),refreshed=Promise.withResolvers<void>();
  const releases:(()=>void)[]=[];
  let active=0,peak=0,reads=0,lists=0;
  const request:TaskRequest=async(_session,operation,id)=>{
    if(operation==='list'){lists++;return {tasks};}
    peak=Math.max(peak,++active);reads++;
    if(reads===4)first.resolve();if(reads===7)second.resolve();
    await new Promise<void>(resolve=>releases.push(resolve));active--;
    return tasks.find(task=>task.id===id)!;
  };
  const store=new WorkerTaskStore('parallel',request,()=>false,()=>{});
  const stops=tasks.map(task=>store.subscribe(()=>{
    if(store.getSnapshot().details.size===7){loaded.resolve();if(lists===2)refreshed.resolve();}
  },task.id,true));
  try{
    await first.promise;assert.equal(reads,4);assert.equal(active,4);
    releases.splice(0).forEach(release=>release());
    await second.promise;assert.equal(reads,7);assert.ok(active<=4);
    releases.splice(0).forEach(release=>release());
    await loaded.promise;assert.equal(store.getSnapshot().details.size,7);assert.equal(peak,4);
    store.refresh();await refreshed.promise;assert.equal(reads,7,'completed output is reused');
  }finally{releases.splice(0).forEach(release=>release());stops.forEach(stop=>stop());}
});

test('unmounting task cards aborts every parallel detail request without publishing stale output', {timeout:5000},async()=>{
  const tasks=Array.from({length:6},()=>({id:crypto.randomUUID(),status:'waiting' as const,pending:[]}));
  const started=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>();
  let reads=0,aborts=0;
  const request:TaskRequest=async(_session,operation,_id,signal)=>{
    if(operation==='list')return {tasks};
    if(++reads===4)started.resolve();
    return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>{
      if(++aborts===4)cancelled.resolve();reject(signal!.reason);
    },{once:true}));
  };
  const store=new WorkerTaskStore('cancel-parallel',request,()=>false,()=>{});
  const stops=tasks.map(task=>store.subscribe(()=>{},task.id,true));
  try{
    await started.promise;stops.forEach(stop=>stop());await cancelled.promise;
    assert.equal(reads,4);assert.equal(store.getSnapshot().details.size,0);assert.equal(store.getSnapshot().error,false);
  }finally{stops.forEach(stop=>stop());}
});
