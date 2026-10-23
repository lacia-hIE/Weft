import assert from 'node:assert/strict';
import { test } from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { createRuntime, tenantId, url } from './helpers/miniflare.ts';

const base = `/v1/tenants/${tenantId('alpha')}`;
const revision = (id: string, number: number, plugins: unknown[]) => ({
  revision: number, publishedAt: new Date(0).toISOString(), upstream: 'an-earlier-upstream',
  spec: {id, name: id, persona: '', workspaceId: 'default', allowClientPlugins: id === 'cordis', plugins},
});

test('official presets Weft published follow the official definition; presets the environment published stay', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-preset-upgrade-'));
  const options = {browser: true, configureModel: false, scriptPath: 'dist/environment-storage-worker.js'};
  let runtime = createRuntime(directory, options);
  try {
    const seeded = await runtime.dispatchFetch(url('alpha', '/_fixture/environment-storage'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
      scope: {tenantId: tenantId('alpha'), environmentId: 'default'}, operation: 'seed-presets',
      document: JSON.stringify([
        revision('standard', 1, [{id: 'persona', config: {prefix: 'earlier'}}]),
        revision('cordis', 1, [{id: 'persona', config: {prefix: 'earlier'}}]),
        revision('cordis', 2, [{id: 'persona', config: {prefix: 'chosen by the environment'}}]),
      ]),
    })});
    assert.equal(seeded.status, 200);
    await runtime.dispose(); runtime = createRuntime(directory, options);
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
    await rm(directory, {recursive: true, force: true});
  }
});
