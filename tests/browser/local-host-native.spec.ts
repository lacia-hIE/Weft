import {test,expect} from '@playwright/test';
test('published local DSH runs native Files, Git, PTY and restores the workbench through Weft',async({page,request},testInfo)=>{
  test.skip(process.env.WEFT_LOCAL_DSH_TEST!=='1','Runs in the dedicated native DSH CI job');
  const {base,project}=await(await request.get('/__test/local-host')).json() as {base:string;project:string};
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const rpc=async(method:string,args:unknown)=>{
    const result=await(await request.post(base+'/local/web/api/'+method,{data:{type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}}})).json();
    expect(result.result.ok,JSON.stringify(result)).toBe(true);return result.result.value;
  };
  await rpc('workspace/create',{request:{path:project}});
  const created=await rpc('session/create',{request:{sessionId:crypto.randomUUID(),cwd:project}});const sessionId=created.sessionId;
  await rpc('session/rename',{request:{sessionId,title:'Local browser session'}});
  // Native account and preview notices resolve independently during boot.
  await page.addLocatorHandler(page.getByRole('dialog',{name:'Get started',exact:true}),async dialog=>{await dialog.getByRole('button',{name:'Close',exact:true}).click();});
  await page.addLocatorHandler(page.getByRole('dialog',{name:'Preview Notice',exact:true}),async dialog=>{await dialog.getByRole('button',{name:'Continue',exact:true}).click();});
  await page.goto('/agents/native-local-ci');
  await expect(page.getByRole('button',{name:'Plugins',exact:true})).toBeVisible({timeout:60_000});
  expect(page.url()).toContain('/local/web/');
  const release=await page.evaluate(()=>(globalThis as {__DSH_BOOT__?:{release:{version:string}}}).__DSH_BOOT__?.release);
  expect(release?.version).toBe('0.2.1-rc.2');
  await page.getByRole('button',{name:'Open right sidebar',exact:true}).click();
  await page.getByRole('button',{name:/New terminal/}).first().click();
  const screen=page.locator('.xterm');await expect(screen).toBeVisible();await screen.click();
  await page.keyboard.type("printf '\\nLOCAL_REAL_PTY_%s\\n' $((20+3))");await page.keyboard.press('Enter');
  await expect(screen).toContainText('LOCAL_REAL_PTY_23',{timeout:30_000});
  await page.keyboard.type("printf '\\nLOCAL_CHANGED_FILE\\n' >> notes.md; git status --porcelain");await page.keyboard.press('Enter');
  await expect(screen).toContainText('M notes.md');
  // Native Files consumes the same on-disk directory used by the terminal.
  await page.keyboard.press('Control+Alt+p');
  const note=page.locator(`[data-files-path="${project}/notes.md"]`);await expect(note).toBeVisible();await note.getByRole('button').click();
  await expect(page.getByText('LOCAL_CHANGED_FILE',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('LOCAL_CHANGED_FILE',{exact:true})).toBeVisible({timeout:45_000});
  const sessions=await rpc('session/list',{_request:{}});expect(sessions.items.some((row:{sessionId:string})=>row.sessionId===sessionId)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('local-dsh-native.png')});expect(errors).toEqual([]);
});
