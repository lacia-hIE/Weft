import {test, expect} from '@playwright/test';
import {compose} from './compose.ts';
import {imageFixtures} from '../helpers/images.ts';

test('the original composer admits an image and reloads its authorized native gallery and lightbox', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'images-' + crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const created = page.waitForResponse(response => response.url().endsWith('/native/api/session/create'), {timeout: 45_000});
  await page.goto('/agents/' + id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await created;
  await expect(page.getByRole('button', {name: 'Select model, current scripted', exact: true})).toBeVisible({timeout: 45_000});
  await compose(page, 'Inspect this red image');
  const fixture = await imageFixtures();
  await page.locator('input[type="file"]').first().setInputFiles({name: 'red-card.png', mimeType: 'image/png', buffer: fixture.png});
  await expect(page.getByRole('img', {name: 'red-card.png', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: ' + me.tenantId, {exact: true})).toBeVisible({timeout: 45_000});
  let payload: {result: {ok: boolean; value: {attachment: {mediaType: string}}}} | undefined;
  const loaded = page.waitForResponse(async response => {
    if (!response.url().endsWith('/native/api/session/attachment')) return false;
    // Consume the body when it arrives. A late response from the old document
    // can lose its Chromium resource during reload; keep waiting for the gallery.
    try {payload = await response.json(); return true;}
    catch (error) {
      if (error instanceof Error && error.message.includes('No resource with given identifier found')) return false;
      throw error;
    }
  }, {timeout: 45_000});
  await page.reload();
  await loaded;
  expect(payload).toBeDefined();
  expect(payload!.result.ok).toBe(true);
  expect(payload!.result.value.attachment.mediaType).toBe('image/webp');
  const image = page.getByRole('img', {name: 'red-card.png', exact: true});
  await expect(image).toBeVisible({timeout: 45_000});
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 64)).toBe(true);
  await image.click();
  await expect(page.getByRole('dialog').getByRole('img', {name: 'red-card.png', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
