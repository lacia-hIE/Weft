import {test, expect} from '@playwright/test';
import sharp from 'sharp';
import type {FileUploadValue} from '@deepseek-ai/dsh-client-file-upload/types';

test('real DeepSeek reads a workspace image with the original read_image tool and restores its native gallery', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live vision provider');
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'image-tool-' + crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const created = page.waitForResponse(response => response.url().endsWith('/native/api/session/create'), {timeout: 45_000});
  await page.goto('/agents/' + id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  const session = await (await created).json() as {result: {value: {sessionId: string}}};
  const sessionId = session.result.value.sessionId;
  const checksum = 'FS-' + crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const pixels = await sharp(Buffer.from(`<svg width="720" height="220" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="220" fill="white"/><text x="30" y="145" font-family="monospace" font-size="86" fill="black">${checksum}</text></svg>`)).png().toBuffer();
  // Seed an actual workspace file; the composer sends only its path, never image bytes.
  const uploaded = await request.post(base + '/native/api/fileUploads/upload', {data: {type: 'client-request', rpcId: crypto.randomUUID(), method: 'fileUploads/upload', payload: {args: {agentId: sessionId, request: {data: pixels.toString('base64'), name: 'workspace-card.png'}}}}});
  expect(uploaded.status()).toBe(200);
  const receipt = await uploaded.json() as {result: {ok: boolean; value: FileUploadValue}};
  expect(receipt.result.ok).toBe(true);
  const file = receipt.result.value.file, digest = file.attachmentId.slice('sha256:'.length);
  const path = `/workspace/.weft/attachments/v1/files/${digest.slice(0, 2)}/${digest}/${file.name}`;
  await page.locator('[contenteditable=true]').fill(`请调用 read_image 工具读取 ${path}，只回复图片中显示的完整校验码，不要添加解释。`);
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText(checksum, {exact: true}).last()).toBeVisible({timeout: 120_000});
  const {events} = await (await request.get(base + '/sessions/' + sessionId + '/events')).json() as {events: Array<{type: string; data: unknown}>};
  expect(events.some(event => event.type === 'tool/call' && JSON.stringify(event.data).includes('read_image'))).toBe(true);
  expect(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('"type":"image"'))).toBe(true);
  expect(JSON.stringify(events.filter(event => event.type === 'user/message'))).not.toContain(checksum);
  await page.reload();
  await expect(page.getByText(checksum, {exact: true}).last()).toBeVisible({timeout: 45_000});
  await page.getByRole('button', {name: /^Completed in /}).click();
  await page.getByRole('button', {name: 'Read images', exact: true}).click();
  // The filename opens the Files sidebar; the row title expands the image card.
  await page.getByRole('button', {name: /^Read image .*workspace-card\.png$/}).first().getByText('Read image', {exact: true}).click();
  const image = page.getByRole('img', {name: 'workspace-card.png', exact: true}).first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 720)).toBe(true);
  await image.click();
  await expect(page.getByRole('dialog').getByRole('img', {name: 'workspace-card.png', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
