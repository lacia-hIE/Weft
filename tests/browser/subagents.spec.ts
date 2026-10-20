import {test, expect, type Page, type APIRequestContext} from '@playwright/test';

async function openDelegator(page: Page, request: APIRequestContext) {
  const {tenantId} = await (await request.get('/v1/me')).json();
  const environment = 'subagents-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45000});
  await page.getByRole('button', {name: 'Account menu', exact: true}).click({timeout: 45000});
  await page.getByRole('menuitem', {name: 'Settings', exact: true}).click();
  await page.getByRole('button', {name: 'Agent presets', exact: true}).click();
  await page.getByRole('button', {name: 'Set as new task default: Delegator', exact: true}).click();
  await expect(page.getByRole('button', {name: 'New task default: Delegator', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', {name: 'Delegator', exact: true})).toBeVisible({timeout: 45000});
  return {environment, tenantId};
}

test('official subagent lineage opens real child history, continues it and restores after refresh', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_SUBAGENTS !== '1', 'Requires the controlled delegation model transport');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const {environment, tenantId} = await openDelegator(page, request);
  await page.locator('[contenteditable=true]').fill('PARENT_TASK: delegate a native task');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('PARENT_NATIVE_REPLY', {exact: true})).toBeVisible({timeout: 45000});
  await page.getByRole('button', {name: /^1 subagent(?: running)?$/}).click();
  const tree = page.getByRole('tree', {name: 'Subagent sessions', exact: true});
  await tree.getByRole('treeitem').filter({hasText: 'Native delegated task'}).click();
  await expect(page.getByText(/^CHILD_TASK_ALPHA/)).toBeVisible();
  expect((await request.post('/__test/subagent-model')).status()).toBe(200);
  await expect(page.getByText('CHILD_NATIVE_REPLY', {exact: true})).toBeVisible({timeout: 45000});
  await page.locator('[contenteditable=true]').fill('CHILD_FOLLOW_BETA');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('CHILD_FOLLOW_REPLY', {exact: true})).toBeVisible({timeout: 45000});
  await page.reload();
  await expect(page.getByText('CHILD_FOLLOW_REPLY', {exact: true})).toBeVisible({timeout: 45000});
  await page.goto('/');
  expect((await request.post('/__test/subagent-restart')).status()).toBe(204);
  await page.goto('/agents/'+environment);
  await expect(page.getByText('CHILD_FOLLOW_REPLY', {exact: true})).toBeVisible({timeout: 45000});
  await page.getByRole('button', {name: 'PARENT_TASK: delegate a native task', exact: true}).click();
  const base = `/v1/tenants/${tenantId}/environments/${environment}/native/api/session/list`;
  await expect.poll(async () => {
    const result = await (await request.post(base, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: {args: {_request: {}}}}})).json();
    const items = result.result.value.items as {sessionId: string; parentSessionId?: string; origin?: string; agentAvailable: boolean}[];
    const parentId = items.find(item => item.origin === 'subagent')?.parentSessionId;
    return items.some(item => item.sessionId === parentId && item.agentAvailable);
  }, {timeout: 30000}).toBe(true);
  await page.getByRole('button', {name: /^1 subagent(?: running)?$/}).click();
  await page.getByRole('tree', {name: 'Subagent sessions', exact: true}).getByRole('treeitem').filter({hasText: 'Native delegated task'}).click();
  await page.locator('[contenteditable=true]').fill('CHILD_FOLLOW_BETA after cold restart');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('CHILD_FOLLOW_REPLY', {exact: true})).toHaveCount(2, {timeout: 45000});
  expect(errors).toEqual([]);
});

test('real DeepSeek delegates through the original tool and opens its actual child conversation', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
  test.setTimeout(300000);
  await openDelegator(page, request);
  const marker = 'CHILD_LIVE_'+crypto.randomUUID().slice(0, 8);
  await page.locator('[contenteditable=true]').fill(`必须调用 subagent 工具，且只创建一个子 Agent。description 为 Live native child。交给子 Agent 的任务：不要再次委派；完成必要的原生父子消息通知后，最终只回复 ${marker}。父 Agent 发起委派后可先结束本轮，收到子结果后简单确认即可，不要重复委派。`);
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await page.getByRole('button', {name: /^1 subagent(?: running)?$/}).click({timeout: 120000});
  const tree = page.getByRole('tree', {name: 'Subagent sessions', exact: true});
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await tree.getByRole('treeitem').click();
  // The child's answer, and its first-prompt LLM title when the model names the Session after it.
  await expect(page.getByText(marker, {exact: true}).first()).toBeVisible({timeout: 120000});
  await page.reload();
  await expect(page.getByText(marker, {exact: true}).first()).toBeVisible({timeout: 45000});
});
