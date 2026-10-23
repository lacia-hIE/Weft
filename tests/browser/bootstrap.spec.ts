import {test, expect} from '@playwright/test';

test('a rejected application chunk shows a recoverable error instead of leaving the loading placeholder', async ({page}) => {
  const chunk = '**/assets/chunk-*.js';
  let rejected = 0;
  await page.route(chunk, route => {
    rejected++;
    return route.fulfill({status: 401, contentType: 'application/json', body: JSON.stringify({error: 'Cloudflare Access user login required'})});
  });
  await page.goto('/');
  await expect(page.getByText('界面资源加载失败，请刷新页面重试。', {exact: true})).toBeVisible();
  expect(rejected).toBeGreaterThan(0);
  await expect(page.getByText('正在连接你的工作空间…', {exact: true})).toHaveCount(0);
  await page.getByText('查看错误详情', {exact: true}).click();
  await expect(page.locator('#root pre')).toContainText('TypeError:');
  await page.unroute(chunk);
  await page.getByRole('button', {name: '重新加载', exact: true}).click();
  await expect(page.getByText('界面资源加载失败，请刷新页面重试。', {exact: true})).toHaveCount(0);
  await expect(page.getByRole('heading', {name: '我的环境', exact: true})).toBeVisible({timeout: 45_000});
});

test('an application evaluation error preserves its cause in the recovery screen', async ({page}) => {
  await page.route('**/assets/app.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: 'throw new ReferenceError("bootstrap evaluation fixture");',
  }));
  await page.goto('/');
  await expect(page.getByText('界面资源加载失败，请刷新页面重试。', {exact: true})).toBeVisible();
  await page.getByText('查看错误详情', {exact: true}).click();
  await expect(page.locator('#root pre')).toHaveText('ReferenceError: bootstrap evaluation fixture');
});
