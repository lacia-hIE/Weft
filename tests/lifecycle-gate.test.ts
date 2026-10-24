import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {LifecycleGate,guardLifecycle} from '../packages/environment-storage/src/lifecycle.ts';

function fixture() {
  const db=new DatabaseSync(':memory:');
  const sql={exec(query:string,...bindings:any[]){const statement=db.prepare(query);const rows=statement.all(...bindings);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];},[Symbol.iterator]:()=>rows[Symbol.iterator]()};}} as unknown as SqlStorage;
  const raw={sql,deleteAlarm:async()=>{},sync:async()=>{},deleteAll:async()=>{for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())db.exec(`DROP TABLE "${String(row.name).replaceAll('"','""')}"`);}} as unknown as DurableObjectStorage;
  const gate=new LifecycleGate(raw);
  const state=gate.state({storage:raw} as DurableObjectState);gate.finishBoot();
  return {db,raw,gate,storage:state.storage};
}

test('lifecycle admission preserves synchronous nested methods and rejects old async writes after resume',async()=>{
  const {db,gate,storage}=fixture();
  class Base { nested(){storage.sql.exec('CREATE TABLE IF NOT EXISTS records (value TEXT)');return 7;} }
  class Owner extends Base {
    lifecycle=gate;
    enter(_scope:object){return this.nested();}
    async continuation(wait:Promise<void>){await wait;storage.sql.exec("INSERT INTO records VALUES ('late')");}
  }
  guardLifecycle(Owner,async()=>{});
  const owner=new Owner();assert.equal(await owner.enter({tenantId:'tenant'}),7);assert.equal(owner.nested(),7);
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  const continuation=owner.continuation(wait);
  gate.transition('suspended',1);assert.throws(()=>owner.nested(),/suspended/);
  gate.transition('active',2);release();await assert.rejects(continuation,/superseded/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM records').get()!).n,0);
  assert.throws(()=>gate.transition('suspended',1),/Stale/);db.close();
});

test('deletion erases payload and leaves a durable tombstone which cannot resume',async()=>{
  const {db,gate,raw,storage}=fixture();
  storage.sql.exec('CREATE TABLE private_data (secret TEXT)');storage.sql.exec("INSERT INTO private_data VALUES ('secret')");
  await gate.purge(3);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['weft_lifecycle']);
  const restored=new LifecycleGate(raw);restored.finishBoot();assert.equal(restored.mode,'deleted');assert.equal(restored.operation,3);
  assert.throws(()=>restored.run(()=>{}),/deleted/);assert.throws(()=>restored.transition('active',4),/deleted/);db.close();
});
