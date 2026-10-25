import {test,expect} from '@playwright/test';
import {compose} from './compose.ts';

test('rc.3 native More menu opens plugins and returns to an unsent Standard draft after creating a plugin draft',async({page,request})=>{
  const {tenantId}=await(await request.get('/v1/me')).json();
  const id='rc3-draft-'+crypto.randomUUID().slice(0,8),base=`/v1/tenants/${tenantId}/environments/${id}/native/api/`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`,{data:{id,name:id}})).status()).toBe(201);
  await page.goto('/agents/'+id);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45_000});
  await expect(page.getByRole('button',{name:'Select model, current scripted',exact:true})).toBeVisible({timeout:45_000});
  await compose(page,'KEEP_UNSENT_STANDARD_DRAFT');
  const more=page.getByRole('navigation',{name:'Global panels'}).getByRole('button',{name:'More',exact:true});
  await more.click();await page.getByRole('menuitem',{name:'Browse other plugins',exact:true}).click();
  await expect(page.getByRole('button',{name:'Plugins',exact:true})).toHaveAttribute('aria-current','page');
  await more.click();await page.getByRole('menuitem',{name:'Create your plugin',exact:true}).click();
  await expect(page.locator('[data-composer-input][contenteditable="true"]').last()).toContainText('Create a DSH plugin');
  await page.getByRole('button',{name:'New session',exact:true}).filter({hasText:'New Session'}).last().click();
  await expect(page.locator('[data-composer-input][contenteditable="true"]').last()).toHaveText('KEEP_UNSENT_STANDARD_DRAFT');
  const result=await(await request.post(base+'session/list',{data:{type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}})).json();
  expect(result.result.ok).toBe(true);expect(result.result.value.items.every((row:{blank:boolean})=>row.blank)).toBe(true);
});

test('rc.2 native Web search form persists Search and Fetch selection and keeps credentials out of settings',async({page,request})=>{
  const {tenantId}=await(await request.get('/v1/me')).json();
  const id='rc2-web-'+crypto.randomUUID().slice(0,8),base=`/v1/tenants/${tenantId}/environments/${id}/native/api/`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`,{data:{id,name:id}})).status()).toBe(201);
  const rpc=async(method:string,args:unknown)=>{const value=await(await request.post(base+method,{data:{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}}})).json();expect(value.result.ok,JSON.stringify(value)).toBe(true);return value.result.value;};
  await page.goto('/agents/'+id);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45_000});
  await page.getByRole('button',{name:'Plugins',exact:true}).click({timeout:45_000});
  await page.getByRole('button',{name:'View Web search',exact:true}).click();
  const toggle=page.getByRole('switch',{name:'Use the new Web Search API',exact:true});
  await expect(toggle).not.toBeChecked();await toggle.click();
  await page.getByRole('textbox',{name:'Search / Fetch API base URL',exact:true}).fill('https://web-api.test/v1');
  await page.getByRole('textbox',{name:'Results per search',exact:true}).fill('4');
  await page.getByLabel('API key',{exact:true}).fill('ui-rc2-web-key');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
  await expect.poll(async()=>{const saved=await rpc('settings/describe',{});return saved.namespaces.find((ns:{ns:string})=>ns.ns==='web-deepseek-api').value;}).toMatchObject({baseURL:'https://web-api.test/v1',count:4});
  const settings=await rpc('settings/describe',{});
  expect(settings.namespaces.find((ns:{ns:string})=>ns.ns==='web').value).toMatchObject({searchProvider:'deepseek-search-api',fetchProvider:'deepseek-fetch-api'});
  expect(settings.namespaces.find((ns:{ns:string})=>ns.ns==='web-deepseek-api').value).toMatchObject({baseURL:'https://web-api.test/v1',count:4});
  expect(JSON.stringify(settings)).not.toContain('ui-rc2-web-key');
  expect(JSON.stringify(await rpc('credentials/describe',{refs:['DEEPSEEK_API_KEY']}))).toContain('"configured":true');
  await page.reload();await page.getByRole('button',{name:'Plugins',exact:true}).click({timeout:45_000});
  await page.getByRole('button',{name:'View Web search',exact:true}).click();
  await expect(toggle).toBeChecked();await expect(page.getByRole('textbox',{name:'Search / Fetch API base URL',exact:true})).toHaveValue('https://web-api.test/v1');
});
