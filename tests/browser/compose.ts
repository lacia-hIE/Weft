import { expect, type Page } from '@playwright/test';

/**
 * Write a prompt into the official composer. The composer may remount while
 * the client prepares its draft Session, dropping text typed just before; the
 * prompt is written again until Send accepts it.
 */
export async function compose(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable=true]');
  const send = page.getByRole('button', {name: 'Send message', exact: true});
  await expect(async () => {
    await composer.fill(text);
    await expect(send).toBeEnabled({timeout: 3_000});
  }).toPass({timeout: 45_000});
}
