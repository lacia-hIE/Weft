import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('the Superagent panel opens from the sidebar, gets its key through Settings and shows what setup still needs', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_IM !== '1', 'Requires the package builder fixture');
  const plugin = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string; version: string};
  const {tenantId} = await (await request.get('/v1/me')).json();
  const environment = 'superagent-ui-' + crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const rpc = async (method: string, args: object) => {
    const answer = await (await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(answer.result.ok, JSON.stringify(answer)).toBe(true);
    return answer.result.value;
  };
  await rpc('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
  const row = (await (await request.get(base + '/native/package-installations')).json()).installations[0];
  expect(row.permissions.client).toBe(true);
  expect((await request.post(base + '/native/package-installations', {data: {operation: 'approve', name: row.name, digest: row.digest, permissions: row.permissions}})).status()).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('/agents/' + environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Superagent', exact: true}).click({timeout: 45_000});
  await expect(page.getByText('The GitHub Source names no repository.').first()).toBeVisible({timeout: 60_000});

  // The credentials are written from the panel and never shown again.
  await page.locator('#dt-tab-settings').click();
  await page.getByRole('button', {name: 'Deployment', exact: true}).click();
  await page.getByLabel('Agent GitHub token', {exact: true}).fill('browser-token');
  await page.getByRole('button', {name: 'Save credentials', exact: true}).click();
  await expect.poll(async () => (await rpc('settings/describe', {})).namespaces.find((item: {ns: string}) => item.ns.endsWith('/dsh-superagent'))
    ?.secrets?.some((secret: {path: string[]; set: boolean}) => secret.path[0] === 'githubToken' && secret.set), {timeout: 30_000}).toBe(true);
  await expect(page.getByLabel('Agent GitHub token', {exact: true})).toHaveValue('');
  expect(errors).toEqual([]);
});
