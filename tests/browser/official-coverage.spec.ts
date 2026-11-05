import { test, expect } from '@playwright/test';
import {compose} from './compose.ts';

// Capabilities a workerd environment explicitly does not provide; see docs/validation/native-interaction.md.
const UNAVAILABLE = (endpoint: string) => /^(api|streams):(account|officeToPdf)\//.test(endpoint);

test('the official Harness UI reaches connected native services everywhere except the declared workerd limits', async ({page, request}) => {
  const failures = new Map<string, string>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const match = /\/native\/(api|streams)\/(.+)$/.exec(new URL(response.url()).pathname);
    if (!match) return;
    const endpoint = `${match[1]}:${decodeURIComponent(match[2]!)}`;
    if (match[1] === 'streams' && (response.headers()['content-type'] ?? '').includes('event-stream')) return;
    const body = await response.json().catch(() => undefined) as {result?: {ok: boolean; error?: {code: string}}} | undefined;
    if (!body?.result?.ok) failures.set(endpoint, body?.result?.error?.code ?? String(response.status()));
  });
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'coverage-'+crypto.randomUUID().slice(0, 8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  await page.goto(`/agents/${id}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  const composer = page.locator('[contenteditable=true]');
  await compose(page, 'coverage prompt');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Tenant: '+me.tenantId, {exact: true})).toBeVisible({timeout: 30_000});
  // Composer popovers: commands, skills and `@` references.
  for (const text of ['/', '@', '@co']) { await composer.fill(text); await page.waitForTimeout(800); }
  await composer.fill('');
  const visit = async (name: string) => {
    await page.getByRole('button', {name, exact: true}).first().click({timeout: 3_000}).catch(() => {});
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
  };
  // My environments leaves the workbench for the site home page.
  for (const name of ['Good response', 'Automation tasks', 'Open right sidebar', 'More actions', 'View options', 'Add files or run commands', 'Plugins']) await visit(name);
  await page.getByRole('button', {name: 'Open right sidebar', exact: true}).first().click({timeout: 3_000}).catch(() => {});
  for (const tab of await page.getByRole('tab').all()) { await tab.click({timeout: 2_000}).catch(() => {}); await page.waitForTimeout(500); }
  // Every settings section of the official dialog.
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  for (const section of ['General', 'Models', 'Built-in plugins', 'Agent presets']) {
    await page.getByRole('button', {name: section, exact: true}).click();
    await page.waitForTimeout(700);
  }
  await expect(page.getByText('tool-web', {exact: true}).or(page.getByText('Agent presets', {exact: true})).first()).toBeVisible();
  await page.waitForTimeout(1_000);
  expect([...failures].filter(([endpoint]) => !UNAVAILABLE(endpoint))).toEqual([]);
  for (const [endpoint, code] of failures) expect(code, endpoint).toBe('gateway/method-unavailable');
  expect(errors).toEqual([]);
});
