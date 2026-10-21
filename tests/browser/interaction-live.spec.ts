import { test, expect } from '@playwright/test';
import {compose} from './compose.ts';

test('real DeepSeek asks through the original question card and continues with the answer chosen in the page', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'ask-live-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await compose(page, 'Call the ask_user_question tool exactly once with one question (id "pick", question "Which codename?") offering exactly two options labeled "Saffron" and "Cobalt". After my answer arrives, reply with only the codename I chose.');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  const option = page.getByText('Cobalt', {exact: true}).first();
  await expect(option).toBeVisible({timeout: 90_000});
  await option.click();
  await page.getByRole('button', {name: 'Submit', exact: true}).click();
  await expect(page.getByText('Which codename?', {exact: true})).toHaveCount(0, {timeout: 30_000});
  await expect(page.getByText(/^Cobalt\.?$/).last()).toBeVisible({timeout: 90_000});
  expect(errors).toEqual([]);
});

test('real DeepSeek runs the original bash tool in the environment shell and reports its output', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'bash-live-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await compose(page, 'Use the bash tool exactly once to run `echo $((1234*5678)) > product.txt && cat product.txt`, then reply with only the number it printed.');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText(/^7006652\.?$/).last()).toBeVisible({timeout: 120_000});
  const file = await request.get(`/v1/tenants/${me.tenantId}/environments/${id}/workspaces/default/files?path=product.txt`);
  expect(await file.text()).toContain('7006652');
  expect(errors).toEqual([]);
});
