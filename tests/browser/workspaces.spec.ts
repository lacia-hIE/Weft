import {test, expect, type APIRequestContext, type Page} from '@playwright/test';
import {compose} from './compose.ts';

async function environment(page: Page, request: APIRequestContext) {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'workspace-picker-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const body = await (await request.post(`${base}/native/api/${method}`, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(body.result.ok, JSON.stringify(body)).toBe(true);
    return body.result.value;
  };
  const write = async (path: string, content: string) => {
    expect((await request.put(base+'/workspaces/default/files', {data: {path, content, expectedVersion: null}})).status()).toBe(200);
  };
  await page.goto('/agents/'+id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  return {me, base, rpc, write};
}

test('the native directory browser adds an existing project and restores its Session and Files sidebar after reload', async ({page, request}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const {me, rpc, write} = await environment(page, request);
  await rpc('directoryPicker/createDirectory', {path: '/workspace', name: 'project-a'});
  await rpc('directoryPicker/createDirectory', {path: '/workspace', name: 'project-b'});
  await write('/workspace/project-a/notes.md', '# Project A\n\nPROJECT_A_FILE');
  await write('/workspace/project-b/sibling.txt', 'PROJECT_B_FILE');
  await write('/workspace/root-only.txt', 'ROOT_FILE');

  await page.getByRole('button', {name: 'Add workspace', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Select Workspace Directory', exact: true});
  await expect(dialog.getByRole('button', {name: 'project-a', exact: true})).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'project-b', exact: true})).toBeVisible();
  await dialog.getByRole('button', {name: 'project-a', exact: true}).click();
  await expect(dialog.getByRole('button', {name: 'Open', exact: true})).toBeEnabled();
  await page.screenshot({path: testInfo.outputPath('workspace-directory-browser.png')});
  await dialog.getByRole('button', {name: 'Open', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'New session in project-a', exact: true})).toBeVisible();
  await compose(page, 'Work in project A');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  const rows = await rpc('session/list', {_request: {}});
  const session = rows.items.find((row: {blank: boolean}) => !row.blank);
  expect(session).toBeTruthy();
  expect(session.cwd).toBe('/workspace/project-a');
  expect(session.projections.values.workingDirectory).toBe('/workspace/project-a');

  await page.locator('[data-sidebar-right-expand]').click();
  await page.locator('[data-sidebar-right-guide-entry="files"]').click();
  await page.locator('[data-files-path="/workspace/project-a/notes.md"]').getByRole('button').click();
  await expect(page.getByText('PROJECT_A_FILE', {exact: true})).toBeVisible();
  await expect(page.locator('[data-files-path="/workspace/root-only.txt"]')).toHaveCount(0);
  await expect(page.locator('[data-files-path="/workspace/project-b/sibling.txt"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('PROJECT_A_FILE', {exact: true})).toBeVisible({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'New session in project-a', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'New session in project-a', exact: true}).click();
  await compose(page, 'Another session in project A');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  const next = await rpc('session/list', {_request: {}});
  expect(next.items.filter((row: {blank: boolean}) => !row.blank).map((row: {cwd: string}) => row.cwd)).toEqual(['/workspace/project-a', '/workspace/project-a']);
  expect(errors).toEqual([]);
});

test('the native picker creates a folder, rejects an unreadable path and starts a terminal in the typed project directory', async ({page, request}, testInfo) => {
  const {me, base, rpc} = await environment(page, request);
  const add = page.getByRole('button', {name: 'Add workspace', exact: true});
  const dialog = page.getByRole('dialog', {name: 'Select Workspace Directory', exact: true});
  await add.click();
  await expect(dialog.getByRole('button', {name: 'New folder', exact: true})).toBeEnabled();
  await dialog.getByRole('button', {name: 'New folder', exact: true}).click();
  const create = page.getByRole('dialog', {name: 'New folder', exact: true});
  await create.getByRole('textbox', {name: 'Folder name', exact: true}).fill('created-project');
  await create.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(create).toHaveCount(0);
  await expect(dialog.getByRole('button', {name: 'created-project', exact: true}).first()).toBeVisible();
  await page.setViewportSize({width: 390, height: 844});
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('workspace-directory-browser-mobile.png')});
  await page.setViewportSize({width: 1280, height: 900});
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  const directory = await rpc('directoryPicker/list', {path: '/workspace'});
  expect(directory.entries.some((row: {path: string}) => row.path === '/workspace/created-project')).toBe(true);

  await add.click();
  await dialog.getByRole('button', {name: 'Edit path', exact: true}).click();
  const path = dialog.getByRole('textbox', {name: 'Edit path', exact: true});
  await path.fill('/workspace/missing');
  await path.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Directory cannot be listed');
  await expect(path).toHaveValue('/workspace/missing');
  await path.fill('/workspace/created-project');
  await path.press('Enter');
  await expect(path).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', {name: 'Open', exact: true})).toBeEnabled();
  await page.screenshot({path: testInfo.outputPath('workspace-typed-directory.png')});
  await dialog.getByRole('button', {name: 'Open', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await compose(page, 'Use the newly created project');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  const rows = await rpc('session/list', {_request: {}});
  expect(rows.items.find((row: {blank: boolean}) => !row.blank).cwd).toBe('/workspace/created-project');

  await page.getByRole('button', {name: 'Open right sidebar', exact: true}).click();
  await page.getByRole('button', {name: /New terminal/}).first().click();
  const screen = page.locator('.xterm');
  await expect(screen).toContainText('weft', {timeout: 30_000});
  await screen.click();
  await page.keyboard.type('pwd; echo project-terminal > terminal.txt');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('/workspace/created-project', {timeout: 30_000});
  await expect.poll(async () => (await request.get(base+'/workspaces/default/files?path=/workspace/created-project/terminal.txt')).status()).toBe(200);
  const written = await request.get(base+'/workspaces/default/files?path=/workspace/created-project/terminal.txt');
  expect(await written.text()).toContain('project-terminal');
  expect((await request.get(base+'/workspaces/default/files?path=/workspace/terminal.txt')).status()).toBe(404);

  await page.reload();
  await expect(page.getByRole('button', {name: 'New session in created-project', exact: true})).toBeVisible({timeout: 45_000});
  await add.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
});
