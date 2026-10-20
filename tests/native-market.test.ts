import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Response, type V4FetchHandler } from 'miniflare';
import type { RemoteEventDownlinkFrame } from '@weft/upstream/packages/api/gateway/src/stream-protocol.ts';
import { createRuntime } from './helpers/miniflare.ts';
import { nativeClient } from './helpers/native.ts';

const INDEX = 'https://market.test/index.json';
const release = (version: string, fields: Record<string, unknown> = {}) => ({version, publishTimestamp: 1, source: {type: 'npm'}, ...fields});

/** Only index HTTP is served by the fixture; parsing, search, compatibility and settings are the original reader's. */
test('the original plugin market reads environment index sources, searches them and keeps installation with pluginManager', {timeout: 120_000}, async () => {
  let fetches = 0;
  const outbound: V4FetchHandler = async request => {
    const target = new URL(request.url);
    if (target.href === INDEX) {
      fetches++;
      return Response.json({format: 1, title: 'Fixture market', plugins: [
        {name: 'weft-fixture-notes', description: 'Take notes', versions: [release('1.0.0'), release('1.1.0')]},
        {name: 'weft-fixture-future', description: 'Needs a newer runtime', versions: [release('2.0.0', {engines: {dsh: '>=99.0.0'}})]},
      ]});
    }
    if (target.href === 'https://market.test/moved.json') return new Response(null, {status: 302, headers: {location: INDEX}});
    throw new Error(`Unexpected market outbound ${request.url}`);
  };
  const runtime = createRuntime(undefined, {browser: true, outbound});
  const api = nativeClient(() => runtime);
  const events = await api.events();
  try {
    assert.equal((await events.next()).type, 'ready');
    assert.deepEqual(await api.call('pluginMarket/listIndexes', {}), []);
    await api.call('pluginMarket/setIndexes', {urls: [INDEX]});
    let frame: RemoteEventDownlinkFrame;
    do frame = await events.next(); while (!(frame.type === 'emit' && frame.event === 'plugin-market/changed'));

    const page = await api.call<{title: string; total: number; entries: {name: string; defaultVersion?: string; installation: {status: string}; versions: {version: string; install: {spec: string}; compatibility: {compatible: boolean}}[]}[]}>(
      'pluginMarket/search', {url: INDEX, query: {text: 'notes', sort: {kind: 'relevance'}, offset: 0, limit: 10}});
    assert.equal(page.title, 'Fixture market');
    assert.deepEqual(page.entries.map(entry => entry.name), ['weft-fixture-notes']);
    assert.equal(page.entries[0]!.defaultVersion, '1.1.0');
    assert.equal(page.entries[0]!.installation.status, 'not-installed');
    assert.equal(page.entries[0]!.versions.find(version => version.version === '1.1.0')?.install.spec, 'weft-fixture-notes@1.1.0');

    const all = await api.call<{total: number; entries: {name: string; versions: {compatibility: {compatible: boolean}}[]}[]}>('pluginMarket/search', {url: INDEX, query: {sort: {kind: 'index'}, offset: 0, limit: 10}});
    assert.equal(all.total, 2);
    assert.equal(all.entries.find(entry => entry.name === 'weft-fixture-future')?.versions[0]?.compatibility.compatible, false, 'engines.dsh is checked against the pinned runtime version');

    assert.deepEqual((await api.call<{url: string; title?: string}[]>('pluginMarket/listIndexes', {})).map(row => [row.url, row.title]), [[INDEX, 'Fixture market']]);
    assert.ok(fetches >= 1);

    const unknown = await api.raw('pluginMarket/search', {url: 'https://market.test/other.json', query: {sort: {kind: 'index'}, offset: 0, limit: 10}});
    assert.equal(unknown.result.error?.code, 'plugin-market/unknown-index');
    await api.call('pluginMarket/setIndexes', {urls: [INDEX, 'https://market.test/moved.json']});
    const moved = await api.raw('pluginMarket/search', {url: 'https://market.test/moved.json', query: {sort: {kind: 'index'}, offset: 0, limit: 10}});
    assert.equal(moved.result.error?.code, 'plugin-market/fetch-failed', 'redirects are not followed');

    const install = await api.call<{application: string}>('pluginManager/installBundle', {spec: 'weft-fixture-notes@1.1.0'});
    assert.equal(install.application, 'failed', 'package installation stays refused until the build service exists');
  } finally {
    await events.close();
    await runtime.dispose();
  }
});
