import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {PackageRegistry} from '../packages/package-install/src/registry.ts';
import type {Installation} from '../packages/package-install/src/contracts.ts';

test('legacy installation records remain removable and cannot reuse approvals or break native bundle listings', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const storage = {sql: {exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(query).all(...bindings);
      return {toArray: () => rows};
    }}} as unknown as DurableObjectStorage;
    const registry = new PackageRegistry(storage);
    const native: Installation = {name:'native-bundle',version:'1.0.0',digest:'a'.repeat(64),enabled:true,approved:true,patch:[{insert:[{id:'native',name:'native-bundle'}]}],rows:[{id:'native',name:'native-bundle'}],permissions:{files:'read',tools:true,timer:false,client:false},description:'Native package',installedAt:1};
    registry.save(native);
    const {patch:_patch,rows:_rows,...legacy} = {...native,name:'legacy-bundle'};
    db.prepare('INSERT INTO weft_installed_packages VALUES (?,?)').run(legacy.name,JSON.stringify(legacy));
    const row = registry.get(legacy.name)!;
    assert.equal(row.needsReinstall,true);
    assert.equal(row.enabled,false);
    assert.equal(row.approved,false);
    assert.deepEqual(registry.get(native.name),native);
    assert.match(registry.bundles().find(bundle=>bundle.name===legacy.name)!.error!.diagnostic ?? '',/reinstall/);
    assert.equal(registry.plugins().find(plugin=>plugin.moduleName===legacy.name)!.enabled,false);
    registry.remove(legacy.name);
    assert.equal(registry.get(legacy.name),undefined);
    assert.deepEqual(registry.bundles().map(bundle=>bundle.name),[native.name]);
  } finally {db.close();}
});

test('version switches revoke first, restore on failure and recover interrupted receipts without transferring grants', async()=>{
  const {PackageInstaller}=await import('../packages/package-install/src/host.ts');
  const {sha256}=await import('../packages/package-install/src/contracts.ts');
  const db=new DatabaseSync(':memory:');let revokeFails=false,changed=0;
  const objects=new Map<string,string>();
  const storage={sql:{exec(query:string,...bindings:(string|number|null)[]){return {toArray:()=>db.prepare(query).all(...bindings)};}},
    sync:async()=>{},setAlarm:async()=>{},transactionSync:(callback:()=>unknown)=>callback()};
  const owner={state:{storage} as unknown as DurableObjectState,scope:{tenantId:'fixture',environmentId:'fixture'},
    bucket:{get:async(key:string)=>objects.has(key)?{text:async()=>objects.get(key)!}:null} as unknown as R2Bucket,
    build:async()=>{throw new Error('not used');},validate:async()=>{},changed:async()=>{changed++;},
    revoke:async():Promise<void>=>{assert.equal(installer.registry.get('fixture')!.enabled,false);if(revokeFails)throw new Error('Release failed');}};
  const installer=new PackageInstaller(owner);
  async function receipt(version:string):Promise<Installation>{
    const artifact={name:'fixture',version,description:'',patch:[],rows:[],permissions:{files:'write' as const,tools:true,timer:true,client:true},lock:[]};
    const body=JSON.stringify(artifact),digest=await sha256(body);
    const {artifactKey}=await import('../packages/package-install/src/contracts.ts');objects.set(artifactKey(owner.scope,digest),body);
    return {...artifact,digest,enabled:true,approved:true,installedAt:1};
  }
  try{
    const old=await receipt('1.0.0'),candidate={...await receipt('1.1.0'),approved:false,enabled:false};
    installer.registry.save({...old,candidate});
    await installer.approve('fixture',candidate.digest);
    // Roll back to make a second, fault-injected switch from the same old version.
    await installer.rollback('fixture',candidate.digest);
    revokeFails=true;
    await assert.rejects(installer.approve('fixture',candidate.digest),/Release failed/);
    assert.equal(installer.registry.get('fixture')!.digest,old.digest);assert.equal(installer.registry.get('fixture')!.enabled,true);
    revokeFails=false;
    await installer.approve('fixture',candidate.digest,{...candidate.permissions,files:'read',client:false});
    assert.equal(installer.registry.get('fixture')!.permissions.files,'read');assert.equal(installer.registry.get('fixture')!.permissions.client,false);
    assert.equal(await installer.failed('fixture',old.digest,'client'),false);
    assert.equal(await installer.failed('fixture',candidate.digest,'host'),true);
    assert.equal(installer.registry.get('fixture')!.digest,old.digest);
    const interrupted={...installer.registry.get('fixture')!,enabled:false,switching:{enabled:true}};
    installer.registry.save(interrupted);
    await installer.recover();
    assert.equal(installer.registry.get('fixture')!.enabled,true);assert.equal(installer.registry.get('fixture')!.switching,undefined);
    assert.match(installer.registry.get('fixture')!.lastError!,/interrupted/);
    assert.ok(changed>=5);
  }finally{db.close();}
});
