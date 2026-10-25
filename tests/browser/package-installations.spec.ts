import {test, expect} from '@playwright/test';
import {buildPackage} from '../../apps/plugin-builder/server.mjs';
import {styledPackageFixture} from '../helpers/package-fixture.ts';

test('native bundle detail reviews the original patch and artifact without a second installation page', async ({page,request})=>{
  const me=await(await request.get('/v1/me')).json() as {tenantId:string};
  const environment='bundle-review-'+crypto.randomUUID().slice(0,8);
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`,{data:{id:environment,name:environment}})).status()).toBe(201);
  const digest='a'.repeat(64),permissions={files:'write',tools:true,timer:true,client:false};let approved=false;
  const row=()=>({name:'@fixture/review',version:'1.2.3',digest,enabled:approved,approved,permissions,description:'Original bundle review fixture',patch:[{insert:[{id:'review',name:'@fixture/review'}]}],rows:[{id:'review',name:'@fixture/review'}],installedAt:1});
  await page.route('**/native/api/pluginManager/listBundles',async route=>{
    const response=await route.fetch(),body=await response.json();
    body.result.value.push({name:row().name,version:'1.2.3',description:row().description,official:false,availability:'profile',installed:true,enabled:approved,optional:false,removable:true,rows:[{rowId:'review',moduleName:row().name}],overrides:[]});await route.fulfill({response,json:body});
  });
  await page.route('**/native/package-installations',async route=>{
    const body=route.request().method()==='POST'?route.request().postDataJSON() as {operation:string;digest?:string}:undefined;
    if(body?.operation==='approve'){expect(body.digest).toBe(digest);approved=true;}
    await route.fulfill({json:body?.operation==='review'?{...row(),lock:[{name:row().name,version:'1.2.3',integrity:'sha512-fixture',tarball:'https://registry.npmjs.org/fixture.tgz'}],host:'export default runtime=>runtime.compose([],{});'}:{available:true,installations:[row()],jobs:[]}});
  });
  await page.goto('/agents/'+environment);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45000});
  await page.getByRole('button',{name:'Plugins',exact:true}).click({timeout:45000});
  await expect(page.getByRole('button',{name:'View Package installations',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'View @fixture/review',exact:true}).click();
  await page.getByRole('button',{name:'Review artifact and permissions',exact:true}).click();
  await expect(page.getByText('SHA-256: '+digest,{exact:true})).toBeVisible();
  await expect(page.getByText(/Client modules execute in the workbench/)).toBeVisible();
  await page.getByRole('button',{name:'Approve this version and enable',exact:true}).click();
  await expect(page.getByText('Enabled',{exact:true})).toBeVisible();
});

test('standard Client CSS, inline CSS, static URLs and native controls restore and unload with the bundle',async({page,request})=>{
  const fixture=styledPackageFixture();
  const artifact=await buildPackage(fixture.input);
  const {tenantId}=await(await request.get('/v1/me')).json();const environment='client-bundle-'+crypto.randomUUID().slice(0,8),base=`/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`,{data:{id:environment,name:environment}})).status()).toBe(201);
  let enabled=true;
  await page.route('**/native/package-installations',route=>route.fulfill({json:{available:true,jobs:[],installations:[{name:fixture.name,version:fixture.version,digest:'b'.repeat(64),patch:artifact.patch,rows:artifact.rows,permissions:artifact.permissions,approved:true,enabled,description:'',installedAt:1}]}}));
  await page.route('**/native/package-assets/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/client.js'))return route.fulfill({contentType:'text/javascript',body:artifact.client!});
    if(path.endsWith('/client.css'))return route.fulfill({contentType:'text/css',body:artifact.css!});
    const asset=artifact.assets?.['assets/'+path.split('/assets/')[1]];
    return asset?route.fulfill({contentType:'image/svg+xml',body:Buffer.from(asset,'base64')}):route.fulfill({status:404});
  });
  await page.goto('/agents/'+environment);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45000});
  const styled=page.locator('[data-styled-fixture]');
  await expect(styled).toBeVisible({timeout:45000});
  await expect(styled).toHaveCSS('color','rgb(17, 34, 51)');
  await expect(styled).toHaveCSS('border-top-width','3px');
  await expect(styled).toHaveCSS('border-bottom-width','2px');
  await expect.poll(()=>page.getByAltText('Plugin icon').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(8);
  await page.reload();await expect(styled).toBeVisible({timeout:45000});
  await expect(page.locator('link[data-plugin-css]')).toHaveCount(1);
  enabled=false;const method='pluginManager/setPluginEnabled';
  expect((await(await request.post(base+'/native/api/'+method,{data:{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{id:'command-feedback',enabled:false}}}})).json()).result.ok).toBe(true);
  await expect(styled).toHaveCount(0);
  await expect(page.locator('link[data-plugin-css]')).toHaveCount(0);
});

test('native bundle details stage updates, approve exact versions and restore Client styles on rollback',async({page,request})=>{
  const {packageFixture}=await import('../helpers/package-fixture.ts');
  const fixtures=[styledPackageFixture('1.2.3'),styledPackageFixture('1.2.4'),packageFixture({version:'1.2.5',files:{'client.js':"export function apply(){throw new Error('Broken client fixture')}"}})];
  const artifacts=await Promise.all(fixtures.map(fixture=>buildPackage(fixture.input)));
  const revisions=artifacts.map((artifact,index)=>({name:artifact.name,version:artifact.version,digest:String(index+1).repeat(64),permissions:artifact.permissions,patch:artifact.patch,rows:artifact.rows,description:artifact.description,installedAt:1,enabled:true,approved:true}));
  type Row=typeof revisions[number] & {candidate?:typeof revisions[number];previous?:typeof revisions[number];lastError?:string};
  let row:Row={...revisions[0]!},signal=true;
  const {tenantId}=await(await request.get('/v1/me')).json(),environment='update-bundle-'+crypto.randomUUID().slice(0,8),base=`/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`,{data:{id:environment,name:environment}})).status()).toBe(201);
  const notify=async()=>{signal=!signal;const method='pluginManager/setPluginEnabled';expect((await(await request.post(base+'/native/api/'+method,{data:{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{id:'command-feedback',enabled:signal}}}})).json()).result.ok).toBe(true);};
  await page.route('**/native/api/pluginManager/listBundles',async route=>{
    const response=await route.fetch(),body=await response.json();
    body.result.value.push({name:row.name,version:row.version,description:'Update fixture',official:false,availability:'profile',installed:true,enabled:row.enabled,optional:false,removable:true,rows:[{rowId:'counter',moduleName:row.name}],overrides:[]});await route.fulfill({response,json:body});
  });
  await page.route('**/native/package-assets/**',route=>{
    const path=new URL(route.request().url()).pathname,index=revisions.findIndex(revision=>path.includes(revision.digest)),artifact=artifacts[index];
    if(!artifact || row.digest!==revisions[index]?.digest)return route.fulfill({status:409});
    if(path.endsWith('/client.js'))return route.fulfill({contentType:'text/javascript',body:artifact.client!});
    if(path.endsWith('/client.css'))return route.fulfill({contentType:'text/css',body:artifact.css!});
    const asset=artifact.assets?.['assets/'+path.split('/assets/')[1]];return asset?route.fulfill({contentType:'image/svg+xml',body:Buffer.from(asset,'base64')}):route.fulfill({status:404});
  });
  await page.route('**/native/package-installations',async route=>{
    const body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
    if(body?.operation==='review')return route.fulfill({json:artifacts[revisions.findIndex(revision=>revision.digest===body.digest)]});
    if(body?.operation==='install'){
      expect(row.version).toBe('1.2.3');expect(row.enabled).toBe(true);
      const target=revisions.find(revision=>body.spec===`${revision.name}@${revision.version}`)!;
      row={...row,candidate:{...target,approved:false,enabled:false}};
    }
    if(body?.operation==='approve'){
      expect(body.digest).toBe(row.candidate!.digest);
      row={...row.candidate!,enabled:true,approved:true,previous:{...row,candidate:undefined} as typeof revisions[number]};await notify();
    }
    if(body?.operation==='rollback'){
      expect(body.digest).toBe(row.digest);row={...row.previous!,candidate:{...row,approved:false,enabled:false}};await notify();
    }
    if(body?.operation==='discard') {const {candidate:_candidate,...rest}=row;row=rest;}
    if(body?.operation==='client-failed'){
      expect(row.version).toBe('1.2.5');expect(body.digest).toBe(row.digest);
      row={...row.previous!,candidate:{...row,approved:false,enabled:false},lastError:'Client activation failed for 1.2.5.'};await notify();
      return route.fulfill({json:{changed:true}});
    }
    return route.fulfill({json:{available:true,installations:[row],jobs:[]}});
  });
  await page.goto('/agents/'+environment);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45000});
  const styled=page.locator('[data-styled-fixture]');await expect(styled).toContainText('1.2.3',{timeout:45000});
  await page.getByRole('button',{name:'Plugins',exact:true}).click();await page.getByRole('button',{name:`View ${row.name}`,exact:true}).click();
  async function update(version:string){
    await page.getByRole('textbox',{name:'Target version',exact:true}).fill(version);
    await page.getByRole('button',{name:'Build update',exact:true}).click();
    await expect(styled).toContainText('1.2.3');
    await page.getByRole('button',{name:'Review update',exact:true}).click();
    await expect(page.getByText('SHA-256: '+row.candidate!.digest,{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Approve this version and enable',exact:true}).click();
  }
  await update('1.2.4');await expect(styled).toContainText('1.2.4');await expect(styled).toHaveCount(1);await expect(page.locator('link[data-plugin-css]')).toHaveCount(1);
  await page.getByRole('button',{name:'Restore previous version (1.2.3)',exact:true}).click();await expect(styled).toContainText('1.2.3');
  await page.getByRole('button',{name:'Discard update',exact:true}).click();
  await update('1.2.5');await expect(styled).toContainText('1.2.3');await expect(page.getByRole('alert').filter({hasText:'Client activation failed for 1.2.5.'})).toBeVisible();
  await expect(page.locator('link[data-plugin-css]')).toHaveCount(1);
  await page.reload();await expect(styled).toContainText('1.2.3');await expect(styled).toHaveCSS('color','rgb(17, 34, 51)');
});
