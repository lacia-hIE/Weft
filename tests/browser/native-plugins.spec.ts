import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';

async function openEnvironment(page: Page, request: APIRequestContext) {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const environment = 'native-plugins-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id: environment, name: environment}})).status()).toBe(201);
  await page.goto(`/agents/${environment}`);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Settings', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'Agent presets', exact: true}).click();
  await page.getByRole('button', {name: 'Set as new task default: Creator mode', exact: true}).click();
  await expect(page.getByRole('button', {name: 'New task default: Creator mode', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', {name: 'Creator mode', exact: true})).toBeVisible({timeout: 45_000});
  return {base};
}

test('official Cordis approval and plugin UI use real native packages and scoped Dynamic Worker handlers', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_PLUGINS !== '1', 'Requires the controlled plugin authoring model transport');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const {base} = await openEnvironment(page, request);
  const openPanel = async () => {
    const badge = page.getByRole('button', {name: 'Cordis plugins', exact: true});
    if (await badge.getAttribute('aria-expanded') !== 'true') await badge.click();
  };
  await page.locator('[contenteditable=true]').fill('Create the native counter plugin');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('Native plugin ready for review', {exact: true})).toBeVisible({timeout: 30_000});
  await expect(page.getByRole('button', {name: 'Native count 0', exact: true})).toHaveCount(0);
  // The official panel opens itself when an approval request appears.
  await page.getByRole('button', {name: 'Allow this version only', exact: true}).click({timeout: 30_000});
  const panel = page.locator('[data-cordis-panel]');
  await page.getByRole('button', {name: 'Native count 0', exact: true}).click({timeout: 30_000});
  await expect(page.getByRole('button', {name: 'Native count 1', exact: true})).toBeVisible();
  const file = await request.get(base+'/workspaces/default/files?path=/workspace/plugin-counter.txt');
  expect(file.status()).toBe(200);
  expect(await file.text()).toContain('count:1');
  await page.reload();
  await page.getByRole('button', {name: 'Native count 0', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('button', {name: 'Native count 2', exact: true})).toBeVisible();
  await openPanel();
  await panel.getByRole('button', {name: 'Stop', exact: true}).click();
  await expect(panel.getByRole('button', {name: 'Run', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: /^Native count /})).toHaveCount(0);
  await panel.getByRole('button', {name: 'Run', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Native count 0', exact: true})).toBeVisible();
  await openPanel();
  await panel.getByRole('button', {name: 'Remove', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Cordis plugins', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: /^Native count /})).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.getByRole('button', {name: 'My Agents', exact: true}).click();
  await expect(page).toHaveURL('/');
});

test('real DeepSeek authors a native Cordis UI plugin whose approved Host runs in an isolated facet', async ({page, request}) => {
  test.skip(process.env.WEFT_BROWSER_LIVE !== '1', 'Requires the configured live provider');
  test.setTimeout(300_000);
  const {base} = await openEnvironment(page, request);
  await page.locator('[contenteditable=true]').fill('创建一个双端 Cordis 插件，名字 Native live counter。使用 cordis_inspect_list 和 cordis_inspect_query 确认原生 API 后，用 cordis_define 和 cordis_run 定义并请求运行。Host 用 harness.handle("increment",...) 维护从 0 开始的计数，通过注入的 fs 写入 /workspace/native-live-counter.txt，内容 live:1 等；返回 JSON {count}。Client 直接使用闭包提供的 React（不 import、不用 JSX），用 React.useState 和 React.createElement 在 conversation.session.header.utilities 插槽注册一个按钮，初始文字 LIVE_NATIVE_0，点击后 await host.call("increment",null) 并将文字更新为 LIVE_NATIVE_1 等。code.host 和 code.client 都是返回 Cordis plugin 的普通 JavaScript 函数体。不要直接在回答中输出代码；必须通过工具创建，等待我在原版 Cordis 面板批准。');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  const approve = page.getByRole('button', {name: 'Allow this version only', exact: true});
  // Generated plugins may give a counter button its own accessible label.
  // Assert its visible counter text and real Host/FS effect independently.
  const counter = page.getByRole('button').filter({hasText: /^\s*LIVE_NATIVE_0\s*$/});
  const incremented = page.getByRole('button').filter({hasText: /^\s*LIVE_NATIVE_1\s*$/});
  // The real model can repair an activation from its native diagnostic. Each
  // immutable revision still receives its own explicit human approval.
  for (let revision = 0; revision < 3; revision++) {
    await approve.click({timeout: 120_000});
    await expect(approve).toBeHidden();
    await expect.poll(async () => await counter.isVisible() ? 'ready' : await approve.isVisible() ? 'review' : 'waiting', {timeout: 60_000}).not.toBe('waiting');
    if (await counter.isVisible()) {
      await counter.click();
      await expect.poll(async () => await incremented.isVisible() ? 'ready' : await approve.isVisible() ? 'review' : 'waiting', {timeout: 60_000}).not.toBe('waiting');
      if (await incremented.isVisible()) break;
    }
  }
  await expect(incremented).toBeVisible({timeout: 30_000});
  const file = await request.get(base+'/workspaces/default/files?path=/workspace/native-live-counter.txt');
  expect(file.status()).toBe(200);
  expect(await file.text()).toContain('live:1');
  await page.reload();
  await expect(counter).toBeVisible({timeout: 45_000});
});
