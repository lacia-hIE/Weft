import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('the Superagent panel opens from the sidebar, gets its key through Settings and shows what setup still needs', async ({page, request}, testInfo) => {
  test.skip(process.env.WEFT_BROWSER_IM !== '1', 'Requires the package builder fixture');
  const plugin = JSON.parse(readFileSync('plugins/superagent/package.json', 'utf8')) as {name: string; version: string};
  const {tenantId} = await (await request.get('/v1/me')).json();
  const environment = 'superagent-ui-' + crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  const rpc = async (method: string, args: object) => {
    const answer = await (await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(answer.result.ok, JSON.stringify(answer)).toBe(true);
    return answer.result.value;
  };
  await rpc('pluginManager/installBundle', {spec: `${plugin.name}@${plugin.version}`, options: {requestId: crypto.randomUUID()}});
  const row = (await (await request.get(base + '/native/package-installations')).json()).installations[0];
  expect(row.permissions.client).toBe(true);
  expect((await request.post(base + '/native/package-installations', {data: {operation: 'approve', name: row.name, digest: row.digest, permissions: row.permissions}})).status()).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('/agents/' + environment);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Superagent', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button',{name:'New request',exact:true})).toBeVisible({timeout:60_000});
  await expect(page.getByText('The GitHub Source names no repository.',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'New request',exact:true}).click();
  const requestDialog=page.getByRole('dialog',{name:'New request',exact:true});
  await expect(requestDialog.getByRole('textbox',{name:'Task and acceptance criteria',exact:true})).toBeVisible();
  await expect(requestDialog.getByRole('button',{name:'Submit for evaluation',exact:true})).toBeDisabled();
  await requestDialog.getByRole('button',{name:'Close',exact:true}).click();

  // The credentials are written from the panel and never shown again.
  await page.locator('#dt-tab-settings').click();
  await page.getByRole('button', {name: 'Sources', exact: true}).click();
  const panel = page.locator('#dt-page');
  await expect(panel.getByText('Not set', {exact: true})).toHaveCount(2);
  await page.getByLabel('Agent GitHub token', {exact: true}).fill('browser-token');
  await page.getByRole('button', {name: 'Save credentials', exact: true}).click();
  await expect(panel.getByText('Not set', {exact: true})).toHaveCount(1, {timeout: 45_000});
  await expect(page.getByLabel('Agent GitHub token', {exact: true})).toHaveValue('');

  // Webhook setup: the page shows what GitHub's form asks for, and a generated secret is saved and shown once.
  await expect(page.getByText(new RegExp(`/v1/plugin-hooks/${tenantId}/${environment}/%40weft%2Fdsh-superagent/github$`))).toBeVisible();
  await page.getByRole('button', {name: 'Generate secret and copy', exact: true}).click();
  await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible({timeout: 45_000});
  await expect(panel.getByText('Not set', {exact: true})).toHaveCount(0, {timeout: 45_000});

  await page.getByRole('button',{name:'Remove credential',exact:true}).click();
  await expect(panel.getByText('Not set',{exact:true})).toHaveCount(1,{timeout:45_000});
  await page.getByRole('button',{name:'Remove webhook secret',exact:true}).click();
  await expect(panel.getByText('Not set',{exact:true})).toHaveCount(2,{timeout:45_000});
  // A second Source writes and removes its own secret through the native protected dictionary.
  await panel.locator('[data-add-source]').getByRole('textbox',{name:'Source name',exact:true}).fill('Secondary repository');
  await panel.getByRole('button',{name:'Add Source',exact:true}).click();
  const extraSource=panel.locator('[id^="dt-source-src-"]');
  await expect(extraSource).toHaveCount(1,{timeout:45_000});
  await extraSource.getByRole('textbox',{name:'Repository scope',exact:true}).fill('team/secondary');
  await extraSource.getByRole('button',{name:'Save',exact:true}).click();
  await expect(extraSource.getByRole('button',{name:'Save',exact:true})).toHaveCount(0,{timeout:45_000});
  await extraSource.getByLabel('API credential (optional)',{exact:true}).fill('secondary-private-token');
  // The API credential is the second secret field when the subscription transport is off.
  await extraSource.getByRole('button',{name:'Save this credential',exact:true}).last().click();
  await expect(extraSource.getByRole('button',{name:'Remove credential',exact:true})).toHaveCount(1,{timeout:45_000});
  await expect(extraSource.getByLabel('API credential (optional)',{exact:true})).toHaveValue('');
  await extraSource.getByRole('button',{name:'Remove credential',exact:true}).click();
  await expect(extraSource.getByRole('button',{name:'Remove credential',exact:true})).toHaveCount(0,{timeout:45_000});
  await page.locator('.dt-settings-nav').getByRole('button',{name:'Prompts',exact:true}).click();
  await panel.getByRole('tab',{name:'Collaboration notes',exact:true}).click();
  await panel.getByRole('button',{name:'Add convention',exact:true}).click();
  await panel.getByRole('textbox',{name:'Convention',exact:true}).fill('Verify internal repositories on the connected computer.');
  await panel.getByRole('button',{name:'Save',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Save',exact:true})).toHaveCount(0,{timeout:45_000});
  await panel.getByRole('button',{name:'Delete',exact:true}).click();
  await panel.getByRole('button',{name:'Save',exact:true}).click();
  await expect(panel.getByRole('textbox',{name:'Convention',exact:true})).toHaveCount(0,{timeout:45_000});
  await expect(panel.getByRole('button',{name:'Save',exact:true})).toHaveCount(0,{timeout:45_000});
  await panel.getByRole('button',{name:'Change history',exact:true}).click();
  await panel.getByRole('button',{name:'Load this version',exact:true}).first().click();
  await expect(panel.getByRole('textbox',{name:'Convention',exact:true})).toHaveValue('Verify internal repositories on the connected computer.');
  await panel.getByRole('button',{name:'Save',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Save',exact:true})).toHaveCount(0,{timeout:45_000});
  await page.locator('.dt-settings-nav').getByRole('button',{name:'Advanced',exact:true}).click();
  await expect(page.getByLabel('Agent GitHub token',{exact:true})).toHaveCount(0);

  // The management UI uses the owner's existing Host connection and sends no local execution policy.
  let attachment: {action: string; code: string} | undefined;
  await page.route(`**/v1/tenants/${tenantId}/environments`, route => route.fulfill({json: {environments: [
    {id: 'connected-computer', name: 'My connected DSH', kind: 'local', local: {online: true}},
    {id: 'unconfigured-computer', name: 'Needs local setup', kind: 'local', local: {online: true}},
  ]}}));
  await page.route(`**/environments/*/local/web/api/weft-executor`, async route => {
    if (route.request().method() === 'POST') {attachment = route.request().postDataJSON(); await route.fulfill({json: {configured: true}}); return;}
    await route.fulfill({json: {ready: route.request().url().includes('/connected-computer/')}});
  });
  await page.locator('.dt-settings-nav').getByRole('button', {name: 'Execution', exact: true}).click();
  await page.route(`**/plugin-hooks/${tenantId}/${environment}/%40weft%2Fdsh-superagent/api/models`,route=>route.fulfill({json:{
    default:{provider:'alpha',model:'a'},routableProviders:['alpha','beta'],failures:[],groups:[
      {id:'alpha',name:'Provider Alpha',models:[{id:'a',name:'Model A',reasoning:{efforts:[{id:'high',name:'High'}]}}]},
      {id:'beta',name:'Provider Beta',models:[{id:'b',name:'Model B'}]}
    ]
  }}));
  // Remount the settings block so its catalog read uses the deterministic native-shaped catalog.
  await page.locator('.dt-settings-nav').getByRole('button',{name:'Advanced',exact:true}).click();
  await page.locator('.dt-settings-nav').getByRole('button',{name:'Execution',exact:true}).click();
  const provider=page.getByRole('combobox',{name:'Provider',exact:true});
  await provider.click();await page.getByRole('option',{name:'Provider Alpha',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Model',exact:true})).toHaveValue('Model A');
  const effort=page.getByRole('combobox',{name:'Reasoning effort (optional)',exact:true});
  await effort.click();await page.getByRole('option',{name:'High',exact:true}).click();
  await provider.click();await page.getByRole('option',{name:'Provider Beta',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Model',exact:true})).toHaveValue('Model B');
  await expect(effort).not.toHaveValue('High');
  await provider.click();await provider.fill('Alpha');await provider.press('ArrowDown');await provider.press('Enter');
  await expect(provider).toHaveValue('Provider Alpha');
  await provider.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(provider).toHaveAttribute('placeholder','Provider Alpha');
  await page.screenshot({path:testInfo.outputPath('superagent-model-selectors.png')});
  await provider.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await provider.click();await page.getByRole('option',{name:'Inherit the DSH default',exact:true}).click();
  const computer = page.getByRole('combobox', {name: 'Default execution location', exact: true});
  await expect(computer.locator('option', {hasText: 'My connected DSH'})).toHaveCount(1);
  await expect(computer.locator('option', {hasText: 'Needs local setup'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Generate pairing code', exact: true})).toHaveCount(0);
  await computer.selectOption('local:connected-computer');
  await expect.poll(() => attachment?.action).toBe('attach');
  expect(Object.keys(attachment!).sort()).toEqual(['action', 'code']);
  const credential = JSON.parse(attachment!.code);
  expect(credential.endpoint).toContain(`/v1/plugin-hooks/${tenantId}/${environment}/%40weft%2Fdsh-superagent/executor/`);
  const executorId = credential.endpoint.split('/').at(-1);
  await expect(computer).toHaveValue(executorId);
  await expect(page.getByRole('textbox', {name: 'Ticket directory root', exact: true})).toHaveCount(0);
  await panel.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(panel.getByRole('button', {name: 'Save', exact: true})).toHaveCount(0, {timeout: 45_000});
  await page.screenshot({path: testInfo.outputPath('superagent-connected-computer.png')});
  expect(errors).toEqual([]);
});
