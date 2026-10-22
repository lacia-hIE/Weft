import {test, expect} from '@playwright/test';

test('the Plugins page chooses auto, worker only or always container and the container size', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'runtime-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const value = async () => {
    const response = await (await request.post(base+'/native/api/settings/describe', {data: {type: 'client-request', rpcId: crypto.randomUUID(), method: 'settings/describe', payload: {args: {}}}})).json();
    return response.result.value.namespaces.find((row: {ns: string}) => row.ns === 'workspace-runtime').value;
  };
  const open = async () => {
    await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45_000});
    await page.getByRole('button', {name: 'View Workspace runtime', exact: true}).click({timeout: 45_000});
  };
  await page.goto('/agents/'+id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await open();
  await expect(page.getByText('Source and .git persist.', {exact: false})).toBeVisible();
  await expect(page.getByText('This deployment has no container.', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Stop container', exact: true})).toBeDisabled();
  const shell = page.getByRole('tablist', {name: 'Where commands run', exact: true});
  const size = page.getByRole('tablist', {name: 'Container size', exact: true});
  await expect(shell.getByRole('tab', {name: 'Auto', exact: true})).toHaveAttribute('aria-selected', 'true');
  // Worker only never starts a container, so its size does not apply.
  await shell.getByRole('tab', {name: 'Worker only', exact: true}).click();
  await expect(size.getByRole('tab', {name: 'standard-1', exact: true})).toBeDisabled();
  await shell.getByRole('tab', {name: 'Always container', exact: true}).click();
  await size.getByRole('tab', {name: 'standard-1', exact: true}).click();
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeDisabled();
  expect(await value()).toEqual({shell: 'container', containerInstance: 'standard-1'});
  await page.reload();
  await open();
  await expect(shell.getByRole('tab', {name: 'Always container', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(size.getByRole('tab', {name: 'standard-1', exact: true})).toHaveAttribute('aria-selected', 'true');
});

test('the workspace settings stop control waits for completion and displays a stopped container', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'stop-container-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  let stopped = false, stops = 0;
  await page.route('**/native/workspace-container', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({});
      stops++; await new Promise(resolve => setTimeout(resolve, 300)); stopped = true;
    }
    await route.fulfill({json: {available: true, status: stopped ? 'stopped' : 'running'}});
  });
  await page.goto('/agents/'+id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'View Workspace runtime', exact: true}).click({timeout: 45_000});
  await expect(page.getByText('Container is running', {exact: true})).toBeVisible();
  const stop = page.getByRole('button', {name: 'Stop container', exact: true});
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(page.getByText('Container is stopped', {exact: true})).toBeVisible();
  expect(stops).toBe(1);
  await page.getByRole('button', {name: 'Refresh container state', exact: true}).click();
  await expect(stop).toBeDisabled();
});
