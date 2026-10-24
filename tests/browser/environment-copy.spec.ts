import {test,expect} from '@playwright/test';

test('the environment catalogue copies configuration and files through native controls and survives reload',async({page,request})=>{
  const me=await (await request.get('/v1/me')).json() as {tenantId:string};
  const source='copy-ui-'+crypto.randomUUID().slice(0,8),name='Copied '+source;
  const base=`/v1/tenants/${me.tenantId}/environments`;
  expect((await request.post(base,{data:{id:source,name:source,configuration:'- id: agent-loop\n  config: {maxParallelToolCalls: 3}\n'}})).status()).toBe(201);
  expect((await request.put(`${base}/${source}/workspaces/default/files`,{data:{path:'/workspace/copied.txt',content:'independent workspace',expectedVersion:null}})).status()).toBe(200);
  await page.goto('/');
  const card=page.locator('.home-card-frame').filter({has:page.getByRole('link',{name:`进入 ${source}`,exact:true})});
  await card.getByRole('button',{name:'复制',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'复制环境',exact:true});
  await expect(dialog).toContainText('不复制会话历史');
  await dialog.getByLabel('新环境名称',{exact:true}).fill(name);
  await dialog.getByRole('button',{name:'复制环境',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  const copied=page.getByRole('link',{name:`进入 ${name}`,exact:true});
  await expect(copied).toBeVisible({timeout:60_000});
  const id=(await copied.getAttribute('href'))!.split('/').at(-1)!;
  expect(id).not.toBe(source);
  const file=await (await request.get(`${base}/${id}/workspaces/default/files?path=/workspace/copied.txt`)).json();
  expect(file.value.content).toBe('independent workspace');
  const state=await (await request.get(`${base}/${id}/state`)).json();expect(state.sessions).toEqual([]);
});
