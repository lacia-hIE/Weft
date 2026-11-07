import {test, expect} from '@playwright/test';
import {compose} from './compose.ts';

test('native workbench restores hibernated subscriptions without losing history or composer drafts', async ({page, request}) => {
  const errors: string[] = [];
  const carriers: string[] = [];
  const passiveFetches: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => carriers.push(socket.url()));
  page.on('request', req => {if (/\/native\/streams\/(?:\$events|session\/(?:follow|control)|workspace\/follow|remoteAccess\/follow|job\/list)/.test(req.url())) passiveFetches.push(req.url());});
  const {tenantId} = await (await request.get('/v1/me')).json() as {tenantId: string};
  const environment = 'hibernate-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const body = await (await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(body.result.ok, JSON.stringify(body)).toBe(true);
    return body.result.value;
  };
  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  const prompt = 'Retain native hibernation history '+environment;
  await compose(page, prompt);
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+tenantId, {exact: true})).toBeVisible({timeout: 45_000});
  const {items} = await rpc('session/list', {_request: {}});
  const session: string = items[0].sessionId;
  await expect.poll(async () => (await rpc('session/list', {_request: {}})).items.find((item: {sessionId: string}) => item.sessionId === session)?.running).toBe(false);
  const draft = 'This draft has not been submitted';
  await compose(page, draft);
  const before = carriers.length;
  // workerd's control API can take ten seconds per object to evict; this
  // request hibernates two objects and is not an interactive application RPC.
  expect((await request.post('/__test/native-hibernate', {data: {environment, session}, timeout: 45_000})).status()).toBe(204);
  await rpc('session/rename', {request: {sessionId: session, title: 'Restored after idle'}});
  await expect(page.getByRole('treeitem', {name: /Restored after idle/}).first()).toBeVisible({timeout: 45_000});
  await expect.poll(() => carriers.length).toBeGreaterThan(before);
  await expect(page.locator('[contenteditable=true]')).toHaveText(draft);
  await expect(page.getByText(prompt, {exact: true})).toHaveCount(1);
  await expect(page.getByText('Tenant: '+tenantId, {exact: true})).toHaveCount(1);
  expect(passiveFetches).toEqual([]);
  expect(errors).toEqual([]);
});
