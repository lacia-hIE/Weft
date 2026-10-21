import {test, expect} from '@playwright/test';
import {compose} from './compose.ts';

for (const live of [false, true]) {
  test(live ? 'official search finds real DeepSeek history after a browser refresh' : 'official search finds message content and opens the native conversation after refresh', async ({page, request}) => {
    test.skip(live && process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
    const me = await (await request.get('/v1/me')).json() as {tenantId: string};
    const suffix = crypto.randomUUID().slice(0, 8);
    const environment = 'search-'+suffix;
    expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
    const base = `/v1/tenants/${me.tenantId}/environments/${environment}/native/api/`;
    const rpc = async (method: string, args: unknown) => {
      const response = await request.post(base+method, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}});
      const result = await response.json(); expect(result.result.ok, JSON.stringify(result)).toBe(true); return result.result.value;
    };
    const marker = 'SEARCH_REPLY_'+suffix;
    await page.goto(`/agents/${environment}`);
    await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45000});
    await expect(page.getByRole('button', {name: /Select model, current /})).toBeVisible({timeout: 45000});
    await compose(page, live ? `Reply exactly ${marker}. Do not call tools.` : `Remember this content marker ${marker}.`);
    await page.getByRole('button', {name: 'Send message', exact: true}).click();
    await expect(page.getByText(live ? marker : 'Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 90000});
    const sessions = await rpc('session/list', {_request: {}});
    const target = sessions.items.find((item: {blank: boolean}) => !item.blank);
    expect(target).toBeTruthy();
    const title = 'A distinct title '+suffix;
    await rpc('session/rename', {request: {sessionId: target.sessionId, title}});

    const search = async () => {
      await page.getByRole('button', {name: 'Search sessions', exact: true}).click();
      const input = page.getByPlaceholder('Search session names', {exact: true});
      await input.fill(marker);
      const tree = page.getByRole('tree', {name: 'Search results', exact: true});
      await expect(tree.getByRole('treeitem')).toHaveCount(1, {timeout: 45000});
      await expect(tree.getByText(title, {exact: true})).toBeVisible();
      await expect(tree).toContainText(marker);
      await input.fill('no-matching-history-'+suffix);
      await expect(page.getByText('No matching sessions', {exact: true})).toBeVisible();
      await input.fill(marker);
      await expect(tree.getByRole('treeitem')).toHaveCount(1);
      await tree.getByRole('treeitem').click();
    };
    await search();
    await page.reload();
    await expect(page.getByRole('button', {name: /Select model, current /})).toBeVisible({timeout: 45000});
    await search();
    expect((await rpc('session/search', {request: {query: marker}})).items[0].sessionId).toBe(target.sessionId);
  });
}
