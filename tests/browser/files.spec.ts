import {test, expect} from '@playwright/test';

test('the original Files sidebar previews text and byte images and refreshes external changes', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'files-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const rpc = async (method: string, args: unknown) => {
    const response = await (await request.post(base+'/native/api/'+method, {data: {type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {args}}})).json();
    expect(response.result.ok, JSON.stringify(response)).toBe(true);
    return response.result.value;
  };
  const write = async (path: string, content: string, expectedVersion: string | null = null) => {
    const response = await request.put(base+'/workspaces/default/files', {data: {path, content, expectedVersion}});
    expect(response.status()).toBe(200);
    return (await response.json()).value.version as string;
  };
  const version = await write('native-notes.md', '# Native workspace preview\n\nWEFT_FILE_PREVIEW_INITIAL');
  await page.goto('/agents/'+id);
  expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).nextHopProtocol)).toBe('h2');
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.locator('[contenteditable=true]').fill('Open this environment workspace');
  await page.getByRole('button', {name: 'Send message', exact: true}).click({timeout: 45_000});
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  await page.locator('[data-sidebar-right-expand]').click();
  await page.locator('[data-sidebar-right-guide-entry="files"]').click();
  const file = page.locator('[data-files-path="/workspace/native-notes.md"]');
  await expect(file).toBeVisible();
  await file.getByRole('button').click();
  await expect(page.getByText('WEFT_FILE_PREVIEW_INITIAL', {exact: true})).toBeVisible();
  await write('native-notes.md', '# Native workspace preview\n\nWEFT_FILE_PREVIEW_UPDATED', version);
  await expect(page.getByText('WEFT_FILE_PREVIEW_UPDATED', {exact: true})).toBeVisible();
  await expect(page.getByText('WEFT_FILE_PREVIEW_INITIAL', {exact: true})).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('WEFT_FILE_PREVIEW_UPDATED', {exact: true})).toBeVisible({timeout: 45_000});
  const sessions = await rpc('session/list', {_request: {}});
  expect(sessions.items[0].projections.values.workingDirectory).toBe('/workspace');
  await write('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#34a89d"/></svg>');
  await page.getByRole('tab', {name: 'Files Close', exact: true}).click();
  const drawing = page.locator('[data-files-path="/workspace/drawing.svg"]');
  await expect(drawing).toBeVisible();
  await drawing.getByRole('button').click();
  const image = page.getByRole('img', {name: /drawing\.svg/});
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => [element.complete, element.naturalWidth, element.naturalHeight])).toEqual([true, 120, 60]);
});
