import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {PluginCoordinator} from '../packages/plugin-registry/src/lifecycle.ts';
import type {PluginPlanEntry} from '../packages/plugin-registry/src/types.ts';

test('an ordinary native bundle drives schema, controls, inventory and real Loader fibers without feature-specific host code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-plugin-registry-'));
  try {
    const outfile = join(directory, 'registry.mjs');
    await build({entryPoints: ['tests/fixtures/plugin-registry-host.ts'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'es2024', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error'});
    const host = await import(pathToFileURL(outfile).href) as typeof import('./fixtures/plugin-registry-host.ts');
    const {registry, sections, read, coordinator, counts, ctx} = await host.boot();
    try {
      assert.equal(registry.plan(read).entries[0]?.disabled, true);
      assert.equal(registry.plan(read).entries[0]?.config.value, 7, 'native patch config supplies the namespace base');
      assert.equal(registry.inventory(read)[0]?.patchId, 'ordinary-plugin');
      assert.equal(registry.bundles(read)[0]?.enabled, false);
      const result = await registry.manage('pluginManager/setBundleEnabled', {name: '@test/bundle', enabled: true}, async (control, enabled) => {
        assert.equal(registry.accepts(control), true); sections.set(control.namespace, {[control.key]: enabled}); return true;
      });
      assert.equal(result?.changed, true);
      await coordinator.reconcile(registry.plan(read));
      assert.equal(counts.active, 1); assert.equal(counts.value(), 7);
      await coordinator.reconcile(registry.plan(read)); assert.equal(counts.loads, 1);
      sections.set('ordinary-plugin', {value: 9});
      await coordinator.reconcile(registry.plan(read)); assert.equal(counts.value(), 9); assert.equal(counts.active, 1);
      sections.set('ordinary-plugin', {enabled: false});
      await coordinator.reconcile(registry.plan(read)); assert.equal(counts.active, 0);
      sections.set('ordinary-plugin', {enabled: true, value: 11});
      await coordinator.reconcile(registry.plan(read)); assert.equal(counts.active, 1); assert.equal(counts.value(), 11);
      await coordinator.reconcile({entries: []}); assert.equal(counts.active, 0);
      assert.equal(await registry.manage('pluginManager/setPluginEnabled', {id: 'unknown', enabled: true}, async () => {throw new Error('must not write');}), undefined);
    } finally {await coordinator.dispose(); await ctx.fiber.dispose();}
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('the shared coordinator serializes changes, retries failed applications and unloads removed entries', async () => {
  const calls: string[] = []; let fail = true;
  const entry: PluginPlanEntry = {id: 'independent', name: '@test/independent', target: 'client', disabled: false, config: {}};
  const coordinator = new PluginCoordinator({apply: async row => {calls.push('apply:'+row.disabled); if (fail) {fail = false; throw new Error('temporary');}}, remove: async row => {calls.push('remove:'+row.id);}});
  await assert.rejects(coordinator.reconcile({entries: [entry]}), /temporary/);
  await coordinator.reconcile({entries: [entry]});
  await coordinator.reconcile({entries: [entry]});
  await Promise.all([coordinator.reconcile({entries: [{...entry, disabled: true}]}), coordinator.reconcile({entries: [entry]})]);
  await assert.rejects(coordinator.reconcile({entries: [entry, entry]}), /Duplicate/);
  await coordinator.dispose();
  await coordinator.reconcile({entries: [entry]});
  assert.deepEqual(calls, ['apply:false', 'apply:false', 'apply:true', 'apply:false', 'remove:independent']);
});
