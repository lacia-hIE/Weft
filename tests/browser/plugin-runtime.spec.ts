import {test, expect} from '@playwright/test';

test('runtime diagnostics inspect this browser and an actual Session without activating a cold owner', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const environment = 'runtime-diagnostics-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const body = await (await request.post(base+'/native/api/'+method, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(body.result.ok, JSON.stringify(body)).toBe(true);
    return body.result.value;
  };
  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'View Plugin runtime diagnostics', exact: true}).click();
  const panel = page.locator('[data-plugin-runtime]');
  await expect(panel).toBeVisible();
  const client = panel.locator('[data-runtime-plugin]').filter({hasText: '@deepseek-ai/dsh-client-ui-plugin-manager'});
  await expect(client).toHaveAttribute('data-runtime-phase', 'active');
  await rpc('session/create', {request: {sessionId: 'diagnosed'}});
  await panel.getByRole('combobox', {name: 'Session', exact: true}).selectOption('diagnosed');
  await expect(panel).toContainText('The Session host is inactive');
  const read = await request.get(base+'/native/plugins/runtime?sessionId=diagnosed');
  expect((await read.json()).state).toBe('inactive');
  await rpc('commands/list', {agentId: 'diagnosed'});
  await panel.getByRole('button', {name: 'Refresh status', exact: true}).click();
  await expect(panel.locator('[data-runtime-plugin="llm"]')).toHaveAttribute('data-runtime-phase', 'active');
  await panel.getByRole('searchbox', {name: 'Filter plugins', exact: true}).fill('command-feedback');
  await expect(panel.locator('[data-runtime-plugin="command-feedback"]')).toHaveAttribute('data-runtime-phase', 'active');
  await page.reload();
  await page.getByRole('button', {name: 'Settings', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Built-in plugins', exact: true}).click();
  await page.getByRole('tab', {name: 'Plugin runtime diagnostics', exact: true}).click();
  await expect(page.locator('[data-plugin-runtime]')).toBeVisible();
});
