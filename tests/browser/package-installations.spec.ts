import {test, expect} from '@playwright/test';

test('official Plugins page reviews an exact package artifact before enabling it', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const environment = 'packages-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const digest = 'a'.repeat(64), permissions = {files: 'read', tools: false, timer: false, client: false};
  let installed = false, approved = false;
  // Controlled HTTP responses isolate the review UI; real compiler, storage, facets and revocation run in workerd tests.
  await page.route('**/native/package-installations', async route => {
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() as {operation: string; digest?: string; spec?: string} : undefined;
    if (body?.operation === 'install') {expect(body.spec).toBe('@fixture/review@1.2.3'); installed = true;}
    if (body?.operation === 'approve') {expect(body.digest).toBe(digest); approved = true;}
    const row = {name: '@fixture/review', version: '1.2.3', digest, enabled: approved, approved, permissions, description: 'Review fixture', installedAt: 1};
    const value = body?.operation === 'review'
      ? {abi: 'weft-plugin-v1', name: row.name, version: row.version, description: row.description, permissions, lock: [{name: row.name, version: row.version, integrity: 'sha512-fixture', tarball: 'https://registry.npmjs.org/fixture.tgz'}], host: 'export default ()=>({apply(){}})'}
      : {available: true, installations: installed ? [row] : [], jobs: []};
    await route.fulfill({json: value});
  });
  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'View Package installations', exact: true}).click();
  await page.getByRole('textbox', {name: 'Package and exact version'}).fill('@fixture/review@1.2.3');
  await page.getByRole('button', {name: 'Install and inspect', exact: true}).click();
  await expect(page.getByText('Awaiting approval', {exact: true})).toBeVisible();
  expect(approved).toBe(false);
  await page.getByRole('button', {name: 'Review artifact and permissions', exact: true}).click();
  await expect(page.getByText('SHA-256: '+digest, {exact: true})).toBeVisible();
  await expect(page.getByText(/Client modules execute in the workbench/)).toBeVisible();
  await page.getByRole('button', {name: 'Approve this version and enable', exact: true}).click();
  await expect(page.getByText('Enabled', {exact: true})).toBeVisible();
  await page.reload();
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'View Package installations', exact: true}).click();
  await expect(page.getByText('Enabled', {exact: true})).toBeVisible();
});
