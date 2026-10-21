import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';

const base = `/v1/tenants/${tenantId('alpha')}`;
const revision = (id: string, number: number, plugins: unknown[]) => JSON.stringify({
  revision: number, publishedAt: new Date(0).toISOString(), upstream: 'an-earlier-upstream',
  spec: {id, name: id, persona: '', workspaceId: 'default', allowClientPlugins: id === 'cordis', plugins},
});

test('official presets Weft published follow the official definition; presets the environment published stay', {timeout: 120_000}, async () => {
  const runtime = createRuntime();
  try {
    // Requests wait for the runtime's configuration migrations; /health activates no environment.
    assert.equal((await runtime.dispatchFetch(url('alpha', '/health'))).status, 200);
    const db = await runtime.getD1Database('CONFIG_DB', 'alpha');
    const insert = (id: string, number: number, plugins: unknown[]) => db.prepare('INSERT INTO agent_revisions VALUES (?, ?, ?, ?, ?)').bind(tenantId('alpha'), 'default', id, number, revision(id, number, plugins)).run();
    await insert('standard', 1, [{id: 'persona', config: {prefix: 'earlier'}}]);
    await insert('cordis', 1, [{id: 'persona', config: {prefix: 'earlier'}}]);
    await insert('cordis', 2, [{id: 'persona', config: {prefix: 'chosen by the environment'}}]);
    const latest = async (id: string) => {
      const response = await runtime.dispatchFetch(url('alpha', `${base}/agents/${id}`));
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as {revision: number; spec: {plugins: {id: string; disabled?: boolean}[]}};
    };
    const standard = await latest('standard');
    assert.equal(standard.revision, 2, 'the seeded revision is followed by the current official definition');
    assert.ok(standard.spec.plugins.some(row => row.id === 'tool-fs' && !row.disabled));
    assert.ok(standard.spec.plugins.some(row => row.id === 'tool-pwsh' && row.disabled === true), 'disabled official rows stay listed');
    const cordis = await latest('cordis');
    assert.equal(cordis.revision, 2);
    assert.deepEqual(cordis.spec.plugins.map(row => row.id), ['persona'], 'a revision the environment published is kept');
  } finally {
    await runtime.dispose();
  }
});
