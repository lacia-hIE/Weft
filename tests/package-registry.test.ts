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
