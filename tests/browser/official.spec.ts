import { test, expect } from '@playwright/test';

test('the official Harness entry sends native turns, restores history and scopes browser state per environment', async ({page, request}) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const tenant = `/v1/tenants/${me.tenantId}`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = 'official-a-'+suffix, second = 'official-b-'+suffix;
  for (const id of [first, second]) {
    const created = await request.post(`${tenant}/environments`, {data: {id, name: id}});
    expect(created.status()).toBe(201);
  }
  const native = async (environment: string, method: string, args: unknown) => {
    const response = await request.post(`${tenant}/environments/${environment}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}});
    const envelope = await response.json();
    expect(envelope.result.ok, JSON.stringify(envelope)).toBe(true);
    return envelope.result.value;
  };
  const loaded = await page.goto(`/agents/${first}?ui=official`);
  expect(loaded!.headers()['content-security-policy']).toContain("base-uri 'self'");
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await page.evaluate(() => {
    localStorage.setItem('same-native-key', 'first environment');
    sessionStorage.setItem('same-native-key', 'first session state');
  });
  const message = 'Official native browser '+suffix;
  await page.locator('[contenteditable=true]').fill(message);
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  const sessions = await native(first, 'session/list', {_request: {}});
  expect(sessions.items).toHaveLength(1);
  const commonId: string = sessions.items[0].sessionId;
  await page.reload();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible();
  await expect(page.getByText(message, {exact: true}).last()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('same-native-key'))).toBe('first environment');

  // Native caches often key only by SessionId. Collide that identity in another
  // real environment to exercise both the server boundary and page persistence.
  await native(second, 'session/create', {request: {sessionId: commonId}});
  await native(second, 'session/rename', {request: {sessionId: commonId, title: 'Second environment session'}});
  await page.goto(`/agents/${second}?ui=official`);
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await expect(page.getByText(message, {exact: true})).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem('same-native-key'), sessionStorage.getItem('same-native-key')])).toEqual([null, null]);
  await page.evaluate(() => {
    localStorage.setItem('same-native-key', 'second environment');
    sessionStorage.setItem('same-native-key', 'second session state');
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(`/agents/${first}?ui=official`);
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('same-native-key'), sessionStorage.getItem('same-native-key')])).toEqual(['first environment', 'first session state']);
  expect(failures).toEqual([]);
});

test('the official entry uses real DeepSeek and restores its native history', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const environment = 'official-live-'+crypto.randomUUID().slice(0, 8);
  const created = await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id: environment, name: environment}});
  expect(created.status()).toBe(201);
  await page.goto(`/agents/${environment}?ui=official`);
  await expect(page.getByRole('button', {name: /Select model, current DeepSeek/})).toBeVisible({timeout: 45_000});
  await page.locator('[contenteditable=true]').fill('只回复这一行，不调用工具：WEFT_OFFICIAL_UI_OK');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('WEFT_OFFICIAL_UI_OK', {exact: true})).toBeVisible({timeout: 120_000});
  await page.reload();
  await expect(page.getByText('WEFT_OFFICIAL_UI_OK', {exact: true})).toBeVisible({timeout: 45_000});
});
