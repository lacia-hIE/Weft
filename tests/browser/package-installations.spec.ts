import {test, expect} from '@playwright/test';
import {buildPackage} from '../../apps/plugin-builder/server.mjs';
import {packageFixture} from '../helpers/package-fixture.ts';

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

test('standard Cordis Client exports restore after refresh and unload on native bundle revocation',async({page,request})=>{
  const fixture=packageFixture({files:{'host.js':'export function apply(){}','client.js':`import React from 'react';import {Context} from '@deepseek-ai/cordis';export function apply(ctx){if(!(ctx instanceof Context)||!React.createElement)throw new Error('Platform identity differs');ctx.effect(()=>{const button=document.createElement('button');button.textContent='Installed client active';document.body.append(button);return()=>button.remove()})}`}});
  const artifact=await buildPackage(fixture.input);
  const {tenantId}=await(await request.get('/v1/me')).json();const environment='client-bundle-'+crypto.randomUUID().slice(0,8),base=`/v1/tenants/${tenantId}/environments/${environment}`;
  expect((await request.post(`/v1/tenants/${tenantId}/environments`,{data:{id:environment,name:environment}})).status()).toBe(201);
  let enabled=true;
  await page.route('**/native/package-installations',route=>route.fulfill({json:{available:true,jobs:[],installations:[{name:fixture.name,version:fixture.version,digest:'b'.repeat(64),patch:artifact.patch,rows:artifact.rows,permissions:artifact.permissions,approved:true,enabled,description:'',installedAt:1}]}}));
  await page.route('**/native/package-assets/**',route=>route.fulfill({contentType:'text/javascript',body:artifact.client!}));
  await page.goto('/agents/'+environment);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:45000});
  await expect(page.getByRole('button',{name:'Installed client active',exact:true})).toBeVisible({timeout:45000});
  await page.reload();await expect(page.getByRole('button',{name:'Installed client active',exact:true})).toBeVisible({timeout:45000});
  enabled=false;const method='pluginManager/setPluginEnabled';
  expect((await(await request.post(base+'/native/api/'+method,{data:{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{id:'command-feedback',enabled:false}}}})).json()).result.ok).toBe(true);
  await expect(page.getByRole('button',{name:'Installed client active',exact:true})).toHaveCount(0);
});
