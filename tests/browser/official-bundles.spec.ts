import {test, expect} from '@playwright/test';

test('official Team bundle card installs, selects its browser module and persists enablement', async ({page, request}) => {
  const {tenantId} = await (await request.get('/v1/me')).json();
  const environment = 'teams-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${tenantId}/environments/${environment}/native`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const answer = await (await request.post(base+'/api/'+method, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(answer.result.ok, JSON.stringify(answer)).toBe(true);
    return answer.result.value;
  };
  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45000});
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-agent-team-profile"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('switch')).not.toBeChecked();
  await card.getByRole('switch').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: 'Install', exact: true}).click();
  await expect.poll(async () => (await rpc('pluginManager/listBundles', {})).find((row: {name: string}) => row.name === '@deepseek-ai/dsh-experimental-agent-team-profile')?.enabled).toBe(true);
  await page.reload();
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  await expect(card.getByRole('switch')).toBeChecked();
  const boot = await (await request.get(base+'/plugins/boot')).json();
  expect(boot.entries.some((row: {id: string}) => row.id === '@deepseek-ai/dsh-experimental-client-ui-agent-team')).toBe(true);
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).not.toBeChecked();
  await page.reload();
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  await expect(card.getByRole('switch')).not.toBeChecked();
});
