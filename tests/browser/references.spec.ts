import {test, expect} from '@playwright/test';

test('the @ menu shows current conversation titles and excludes persisted empty Sessions after reload', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'references-' + crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const native = async (method: string, args: unknown) => {
    const response = await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}});
    const body = await response.json();
    expect(body.result.ok, JSON.stringify(body)).toBe(true);
    return body.result.value;
  };
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  const composer = page.locator('[contenteditable=true]');
  await expect(composer).toBeVisible({timeout: 45_000});
  const source = crypto.randomUUID();
  const empty = crypto.randomUUID();
  await native('session/create', {request: {sessionId: source}});
  await native('session/prompt', {request: {sessionId: source, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'Reference menu regression'}]}});
  await expect(async () => {
    const rows = await native('session/list', {_request: {}});
    expect(rows.items.find((row: {sessionId: string}) => row.sessionId === source)).toMatchObject({blank: false, running: false});
  }).toPass({timeout: 30_000});
  await native('session/rename', {request: {sessionId: source, title: '排序算法讨论'}});
  await native('session/create', {request: {sessionId: empty}});
  await native('session/rename', {request: {sessionId: empty, title: '空白草稿'}});
  await composer.fill('@');
  await expect(page.getByRole('option', {name: /排序算法讨论/})).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option', {name: /空白草稿/})).toHaveCount(0);
  await native('session/rename', {request: {sessionId: source, title: '新的排序讨论'}});
  await composer.fill('@新的排序');
  await expect(page.getByRole('option', {name: /新的排序讨论/})).toBeVisible();
  await composer.fill('');
  await page.reload();
  await expect(composer).toBeVisible();
  await composer.fill('@');
  await expect(page.getByRole('option', {name: /新的排序讨论/})).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
});
