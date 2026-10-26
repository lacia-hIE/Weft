import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime, url } from './helpers/miniflare.ts';

test('the environment document preloads every boot graph bundle and only revision-matched bundles are cached as immutable', {timeout: 60_000}, async () => {
  const runtime = createRuntime(undefined, {browser: true});
  try {
    const graph = await (await runtime.dispatchFetch(url('alpha', '/harness/boot.json'))).json() as {entries: {url: string; rev: string}[]};
    assert.ok(graph.entries.length > 0);
    const home = await (await runtime.dispatchFetch(url('alpha', '/'))).text();
    assert.ok(!home.includes('rel="preload" as="script"'), 'the catalogue never downloads the native workbench');
    const page = await (await runtime.dispatchFetch(url('alpha', '/agents/default'))).text();
    for (const entry of graph.entries) assert.ok(page.includes(`<link rel="preload" as="script" href="${entry.url.replace(/&/g, '&amp;')}">`), `preloads ${entry.url}`);
    const current = await runtime.dispatchFetch(url('alpha', graph.entries[0]!.url));
    assert.equal(current.status, 200);
    assert.equal(current.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const stale = await runtime.dispatchFetch(url('alpha', graph.entries[0]!.url.replace(/rev=[a-f0-9]+/, 'rev=' + '0'.repeat(64))));
    assert.equal(stale.headers.get('cache-control'), 'private, no-store', 'a revision the build did not produce is never cached');
    assert.equal((await runtime.dispatchFetch(url('alpha', '/agents/default'))).headers.get('cache-control'), 'private, no-store', 'the document follows each deployment');
    assert.equal((await runtime.dispatchFetch(url('alpha', '/harness/boot.json'))).headers.get('cache-control'), 'private, no-store');
    assert.equal((await runtime.dispatchFetch(url('alpha', '/harness-shell.html'))).status, 404, 'the private document is dispatched by the authenticated router');
  } finally {
    await runtime.dispose();
  }
});
