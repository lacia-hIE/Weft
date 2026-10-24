import {test,expect} from '@playwright/test';
test('local environment uses native controls for pairing and safe removal',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'连接本地 DSH',exact:true}).click();
  await page.getByLabel('环境名称',{exact:true}).fill('My local computer');
  await page.getByRole('button',{name:'生成连接配置',exact:true}).click();
  await expect(page.getByRole('button',{name:'下载连接配置',exact:true})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载连接配置',exact:true}).click();
  expect((await downloadPromise).suggestedFilename()).toBe('weft-connection.json');
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  const card=page.locator('.home-card-frame').filter({hasText:'My local computer'});
  await expect(card).toContainText('等待配对');await expect(card.getByRole('button',{name:'复制',exact:true})).toHaveCount(0);
  await card.getByRole('button',{name:'My local computer 的更多操作'}).click();
  await page.getByRole('menuitem',{name:'删除环境',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('本机的 DSH 数据和进程保留');
  await page.getByLabel('输入环境名称确认删除').fill('My local computer');
  await page.getByRole('button',{name:'删除环境',exact:true}).click();await expect(card).toHaveCount(0);
});
