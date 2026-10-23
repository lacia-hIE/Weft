import {test, expect} from '@playwright/test';
import {sendPrompt} from './compose.ts';

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
  // The official catalog switch opens the progress dialog and installs immediately.
  await expect.poll(async () => (await rpc('pluginManager/listBundles', {})).find((row: {name: string}) => row.name === '@deepseek-ai/dsh-experimental-agent-team-profile')?.enabled).toBe(true);
  await page.reload();
  await page.getByRole('button', {name: 'New session', exact: true}).first().click({timeout: 45000});
  // New session is the draft composer; the original header belongs to a real conversation.
  await sendPrompt(page, 'Verify the official Team panel');
  await page.getByRole('treeitem').filter({hasText: 'Verify the official Team panel'}).click({timeout: 45000});
  const teamAction = page.getByRole('button', {name: 'Agent Team', exact: true});
  await teamAction.click({timeout: 45000});
  const teamPanel = page.getByRole('dialog', {name: 'Agent Team', exact: true});
  await expect(teamPanel.getByRole('heading', {name: /^Members/})).toBeVisible();
  await expect(teamPanel.getByText('No shared tasks yet. Create them through the conversation.', {exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  await expect(card.getByRole('switch')).toBeChecked();
  const boot = await (await request.get(base+'/plugins/boot')).json();
  expect(boot.entries.some((row: {id: string}) => row.id === '@deepseek-ai/dsh-experimental-client-ui-agent-team')).toBe(true);
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).not.toBeChecked();
  await page.reload();
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  await expect(card.getByRole('switch')).not.toBeChecked();
  await expect(page.getByRole('button', {name: 'Agent Team', exact: true})).toHaveCount(0);
});
