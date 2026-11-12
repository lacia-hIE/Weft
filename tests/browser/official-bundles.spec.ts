import {test, expect} from '@playwright/test';
import {sendPrompt} from './compose.ts';

test('built-in Agent Teams: the conversation menu saves Team mode per Session and the retired bundle card is gone', async ({page, request}) => {
  const {tenantId} = await (await request.get('/v1/me')).json();
  const environment = 'teams-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${tenantId}/environments/${environment}/native`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  // DSH 0.2.2-rc.2 ships the Team browser module in the official Web bundle.
  const boot = await (await request.get(base+'/plugins/boot')).json();
  expect(boot.entries.some((row: {id: string}) => row.id === '@deepseek-ai/dsh-client-ui-agent-team')).toBe(true);

  await page.goto('/agents/'+environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45000});
  await page.getByRole('button', {name: 'Plugins', exact: true}).click({timeout: 45000});
  await expect(page.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-agent-team-profile"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'New session', exact: true}).first().click({timeout: 45000});
  await sendPrompt(page, 'Verify the Team mode switch');
  const conversation = page.getByRole('treeitem').filter({hasText: 'Verify the Team mode switch'});
  await conversation.click({timeout: 45000});
  const teamSwitch = async () => {
    await page.getByRole('button', {name: /^Select model, current /}).click({timeout: 45000});
    return page.getByRole('switch', {name: 'Enable agent teamwork', exact: true});
  };
  let toggle = await teamSwitch();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');

  // The selection is saved in the root Session, so it survives a reload.
  await page.reload();
  await conversation.click({timeout: 45000});
  toggle = await teamSwitch();
  await expect(toggle).toBeChecked();
  // After the Session has used its model, turning Team mode off asks for confirmation.
  await toggle.click();
  const confirm = page.getByRole('dialog', {name: 'Disable agent teamwork?', exact: true});
  await confirm.getByRole('button', {name: 'Disable', exact: true}).click({timeout: 45000});
  await expect(confirm).toHaveCount(0);
  toggle = await teamSwitch();
  await expect(toggle).not.toBeChecked();
});
