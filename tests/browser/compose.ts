import { expect, type Page } from '@playwright/test';

/**
 * Write a prompt into the official composer. The composer may remount while
 * the client prepares its draft Session, dropping text typed just before; the
 * prompt is written again until Send is enabled.
 */
export async function compose(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable=true]');
  const send = page.getByRole('button', {name: 'Send message', exact: true});
  await expect(async () => {
    await composer.fill(text);
    await expect(send).toBeEnabled({timeout: 3_000});
  }).toPass({timeout: 45_000});
}

/** Fill and submit together so a draft remount between them cannot strand the test on an empty composer. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.locator('[contenteditable=true]').fill(text);
    const send = page.getByRole('button', {name: 'Send message', exact: true});
    await expect(send).toBeEnabled({timeout: 3_000});
    await send.click({timeout: 3_000});
  }).toPass({timeout: 45_000});
}

/**
 * Wait until the official workbench shows its composer. DSH 0.2.2 shows its
 * preview notice only in the Desktop app, so Web pages open directly.
 */
export async function workbenchReady(page: Page): Promise<void> {
  await expect(page.locator('[contenteditable=true]').first()).toBeVisible({timeout: 45_000});
}
