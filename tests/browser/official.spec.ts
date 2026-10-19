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
  const loaded = await page.goto(`/agents/${first}`);
  expect(loaded!.headers()['content-security-policy']).toContain("base-uri 'self'");
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
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
  await page.goto(`/agents/${second}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await expect(page.getByText(message, {exact: true})).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem('same-native-key'), sessionStorage.getItem('same-native-key')])).toEqual([null, null]);
  await page.evaluate(() => {
    localStorage.setItem('same-native-key', 'second environment');
    sessionStorage.setItem('same-native-key', 'second session state');
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(`/agents/${first}`);
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
  await page.goto(`/agents/${environment}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: /Select model, current DeepSeek/})).toBeVisible({timeout: 45_000});
  await page.locator('[contenteditable=true]').fill('只回复这一行，不调用工具：WEFT_OFFICIAL_UI_OK');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('WEFT_OFFICIAL_UI_OK', {exact: true})).toBeVisible({timeout: 120_000});
  await page.reload();
  await expect(page.getByText('WEFT_OFFICIAL_UI_OK', {exact: true})).toBeVisible({timeout: 45_000});
});

test('official Models settings save real scoped credentials and configuration without reading the key back', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'official-settings-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const body = await (await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(body.result.ok, JSON.stringify(body)).toBe(true);
    return body.result.value;
  };
  const openSettings = async () => {
    await page.getByRole('button', {name: 'Account menu', exact: true}).click({timeout: 45_000});
    await page.getByRole('menuitem', {name: 'Settings', exact: true}).click();
    await page.getByRole('button', {name: 'Models', exact: true}).click();
    // The original editor automatically expands an unconfigured provider.
    const key = page.getByRole('textbox', {name: 'API key', exact: true});
    const edit = page.getByRole('button', {name: 'Edit DeepSeek (deepseek-official)', exact: true});
    await expect(key.or(edit)).toBeVisible();
    if (await edit.isVisible()) await edit.click();
  };
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await openSettings();
  if (process.env.WEFT_BROWSER_PRODUCTION === '1') {
    await expect(page.getByText('No API key saved for this environment. Enter your API key here.', {exact: true})).toBeVisible();
    await expect(page.getByText(/Env var not detected|configure DEEPSEEK_API_KEY/)).toHaveCount(0);
  }
  await page.getByRole('textbox', {name: 'API key', exact: true}).fill('browser-settings-key-fixture');
  await page.getByText('Customized settings', {exact: true}).click();
  await page.getByRole('textbox', {name: 'Base URL', exact: true}).fill('https://browser-model.test/anthropic');
  await page.getByRole('textbox', {name: 'Display name 1', exact: true}).fill('Browser Configured Model');
  await page.getByRole('button', {name: 'Apply', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'API key', exact: true})).toHaveCount(0);
  const stored = await rpc('settings/describe', {});
  expect(JSON.stringify(stored)).toContain('Browser Configured Model');
  expect(JSON.stringify(stored)).toContain('https://browser-model.test/anthropic');
  expect(JSON.stringify(stored)).not.toContain('browser-settings-key-fixture');
  expect(await rpc('credentials/describe', {refs: ['DEEPSEEK_API_KEY']})).toEqual({DEEPSEEK_API_KEY: {configured: true, source: 'environment', writable: true}});
  await page.reload();
  await openSettings();
  await expect(page.getByRole('textbox', {name: 'API key', exact: true})).toHaveValue('');
  await page.getByText('Customized settings', {exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Base URL', exact: true})).toHaveValue('https://browser-model.test/anthropic');
  await expect(page.getByRole('textbox', {name: 'Display name 1', exact: true})).toHaveValue('Browser Configured Model');
  await expect(page.getByRole('button', {name: 'Continue', exact: true})).toHaveCount(0);
});
