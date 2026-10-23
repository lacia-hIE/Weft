import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Response} from 'miniflare';
import {buildPackage} from '../apps/plugin-builder/server.mjs';
import {packageFixture} from './helpers/package-fixture.ts';
import {createRuntime, tenantId, url} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';
import type {InstallJob, Installation, Artifact} from '../packages/package-install/src/contracts.ts';

test('package installation reviews exact artifacts, runs isolated Host modules and survives restart with immediate revocation', {timeout: 120_000}, async () => {
  const fixture = packageFixture(); let builds = 0;
  const directory = await mkdtemp(join(tmpdir(), 'weft-packages-'));
  const options: NonNullable<Parameters<typeof createRuntime>[1]> = {packages: true,
    outbound: async request => {
      const address = new URL(request.url);
      if (address.href === fixture.manifest.dist.tarball) return new Response(fixture.bytes, {headers: {'content-type': 'application/octet-stream'}});
      if (decodeURIComponent(address.pathname) === `/${fixture.name}/${fixture.version}`) return Response.json(fixture.manifest);
      return new Response('not found', {status: 404});
    },
    packageBuilder: async request => {builds++; return Response.json(await buildPackage(JSON.parse(await request.text())));},
  };
  let runtime = createRuntime(directory, options); const api = nativeClient(() => runtime);
  const base = `/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  const call = async <T>(body?: object) => {
    const response = await runtime.dispatchFetch(url('alpha', base+'/package-installations'), body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
    assert.ok(response.ok, await response.clone().text()); return response.json() as Promise<T>;
  };
  const list = () => call<{installations: Installation[]; jobs: InstallJob[]}>();
  try {
    assert.equal((await list()).installations.length, 0);
    const id = crypto.randomUUID(); await call({operation: 'install', spec: `${fixture.name}@${fixture.version}`, requestId: id});
    for (let attempt = 0; attempt < 200; attempt++) {const job = (await list()).jobs.find(row => row.id === id); if (job?.phase === 'review' || job?.phase === 'failed') break; await new Promise(resolve => setTimeout(resolve, 25));}
    const state = await list(); assert.equal(state.jobs[0]?.phase, 'review', JSON.stringify(state.jobs));
    const row = state.installations[0]!; assert.equal(row.approved, false); assert.equal(row.enabled, false);
    const moduleUrl = base+`/package-assets/${row.digest}/client.js?name=${encodeURIComponent(row.name)}`;
    assert.equal((await runtime.dispatchFetch(url('alpha', moduleUrl))).status, 409);
    const artifact = await call<Artifact>({operation: 'review', name: row.name, digest: row.digest}); assert.deepEqual(artifact.lock, fixture.input.lock);
    assert.equal((await runtime.dispatchFetch(url('alpha', base+'/package-installations'), {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.test'}, body: JSON.stringify({operation: 'approve', name: row.name, digest: row.digest})})).status, 403);
    await call({operation: 'approve', name: row.name, digest: row.digest});
    assert.equal((await runtime.dispatchFetch(url('alpha', moduleUrl))).status, 200);
    const betaPath = moduleUrl.replace(tenantId('alpha'), tenantId('beta'));
    assert.equal((await runtime.dispatchFetch(url('beta', betaPath))).status, 409);
    const bundles = await api.call<{name: string; enabled: boolean}[]>('pluginManager/listBundles', {});
    assert.equal(bundles.find(value => value.name === row.name)?.enabled, true);
    await api.call('session/create', {request: {sessionId: 'package-session'}});
    const invoke = () => runtime.dispatchFetch(url('alpha', base+'/package-invoke'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId: 'package-session', name: row.name, digest: row.digest, method: 'save', args: 'from-package'})});
    let result = await invoke(); assert.equal(result.status, 200, await result.clone().text()); assert.deepEqual(await result.json(), {value: {saved: true}});
    await runtime.dispose(); runtime = createRuntime(directory, options);
    assert.equal((await list()).installations[0]?.approved, true);
    result = await invoke(); assert.equal(result.status, 200, await result.clone().text());
    await call({operation: 'install', spec: `${fixture.name}@${fixture.version}`, requestId: id}); assert.equal(builds, 1, 'durable request receipt deduplicates rebuilds');
    const disabled = await api.call<{application: string}>('pluginManager/setBundleEnabled', {name: row.name, enabled: false}); assert.equal(disabled.application, 'applied');
    assert.equal((await invoke()).status, 409); assert.equal((await runtime.dispatchFetch(url('alpha', moduleUrl))).status, 409);
    await api.call('pluginManager/removeBundle', {name: row.name}); assert.equal((await list()).installations.length, 0);
  } finally {await runtime.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('installed read-only packages cannot write, stale approval is refused and private registries never fall back publicly', {timeout: 120_000}, async () => {
  const fixture = packageFixture({declaration: {abi: 'weft-plugin-v1', host: './host.js', permissions: {files: 'read'}}, files: {
    'host.js': `export default sdk=>({inject:['fs'],apply(ctx){
      let denied=false;try{ctx.tools.register(sdk.defineTool({name:'unapproved_tool',description:'Forbidden',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>null}))}catch{denied=true}
      ctx.effect(()=>sdk.handle('permissionStatus',async()=>({denied})));
      ctx.effect(()=>sdk.handle('save',async value=>{const target=await ctx.fs.resolve('/workspace/package-result.txt');await ctx.fs.writeText(target,String(value));return null}));
    }})`,
  }});
  let downloads = 0;
  const runtime = createRuntime(undefined, {packages: true, browser: true,
    outbound: async request => {
      downloads++;
      return request.url === fixture.manifest.dist.tarball ? new Response(fixture.bytes) : Response.json(fixture.manifest);
    }, packageBuilder: async request => Response.json(await buildPackage(JSON.parse(await request.text()))),
  });
  const api = nativeClient(() => runtime), base = `/v1/tenants/${tenantId('alpha')}/environments/default/native`;
  try {
    const refused = await api.call<{status: string}>('pluginManager/inspect', {spec: '@private/plugin@1.0.0', options: {registry: 'https://private.test'}});
    assert.equal(refused.status, 'refused'); assert.equal(downloads, 0);
    const installed = await api.call<{application: string}>('pluginManager/installBundle', {spec: `${fixture.name}@${fixture.version}`});
    assert.equal(installed.application, 'applied');
    const get = async () => (await (await runtime.dispatchFetch(url('alpha', base+'/package-installations'))).json() as {installations: Installation[]}).installations[0]!;
    const row = await get(); assert.equal(row.approved, false);
    const approve = (digest: string) => runtime.dispatchFetch(url('alpha', base+'/package-installations'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({operation: 'approve', name: row.name, digest})});
    assert.equal((await approve('0'.repeat(64))).status, 409); assert.equal((await get()).approved, false);
    assert.equal((await approve(row.digest)).status, 200);
    await api.call('session/create', {request: {sessionId: 'readonly-package'}});
    const status = await runtime.dispatchFetch(url('alpha', base+'/package-invoke'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId: 'readonly-package', name: row.name, digest: row.digest, method: 'permissionStatus', args: null})});
    assert.equal(status.status, 200, await status.clone().text()); assert.deepEqual(await status.json(), {value: {denied: true}});
    const response = await runtime.dispatchFetch(url('alpha', base+'/package-invoke'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sessionId: 'readonly-package', name: row.name, digest: row.digest, method: 'save', args: 'denied'})});
    assert.equal(response.status, 409); assert.match(await response.text(), /permission denied/);
  } finally {await runtime.dispose();}
});
