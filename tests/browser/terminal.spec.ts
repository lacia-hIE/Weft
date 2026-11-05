import { test, expect } from '@playwright/test';
import {compose} from './compose.ts';

test('the official Terminal sidebar runs commands in the environment shell', async ({page, request}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'terminal-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await compose(page, 'hello terminal');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  await page.getByRole('button', {name: 'Open right sidebar', exact: true}).click();
  await page.getByRole('button', {name: /New terminal/}).first().click();
  const screen = page.locator('.xterm');
  await expect(screen).toContainText('weft', {timeout: 30_000});
  await screen.click();
  await page.keyboard.type('echo browser-$((20+3))');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('browser-23', {timeout: 30_000});
  expect(errors).toEqual([]);
});
