import {mkdtempSync,mkdirSync,writeFileSync,openSync,closeSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import type {Miniflare} from 'miniflare';
import {tenantId,url} from './miniflare.ts';
/** CI-only fixture: start the published, unmodified DSH with our real plugin. */
export async function startLocalDsh(runtime:Miniflare,certificate:string):Promise<{project:string;base:string;stop:()=>Promise<void>}> {
  const root=mkdtempSync(join(tmpdir(),'weft-local-dsh-')),project=join(root,'project');mkdirSync(project);
  writeFileSync(join(project,'notes.md'),'# Local project\n\nLOCAL_DSH_FILE\n');
  execFileSync('git',['init','--initial-branch=main',project]);execFileSync('git',['-C',project,'add','.']);
  execFileSync('git',['-C',project,'-c','user.name=CI','-c','user.email=ci@example.invalid','commit','-m','Initial project']);
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/native-local-ci`;
  const post=(path:string,body:unknown)=>runtime.dispatchFetch(url('alpha',path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if((await post(`/v1/tenants/${tenant}/environments`,{id:'native-local-ci',name:'Native local CI',kind:'local'})).status!==201)throw new Error('Could not register local fixture');
  const {pairingKey}=await(await post(base+'/local/pairing',{})).json() as {pairingKey:string};
  const file=join(root,'connection.json');writeFileSync(file,JSON.stringify({endpoint:`https://127.0.0.1:4173/v1/local-hosts/${tenant}/native-local-ci`,pairingKey}),{mode:0o600});
  const patch=join(root,'connector.patch.yml');writeFileSync(patch,JSON.stringify([{insert:[{id:'weft-local-host',name:resolve('packages/local-host-connector/index.mjs'),config:{connectionFile:file}}]}]));
  const output=openSync('.generated/local-dsh-native.log','w');
  const child:ChildProcess=spawn(resolve('.generated/local-dsh/node_modules/.bin/dsh'),['--profile','web','--patch',patch,'--no-open','--port',String(port)],{cwd:project,env:{...process.env,DSH_HOME:join(root,'home'),DSH_AGENTS_HOME:join(root,'agents'),NODE_EXTRA_CA_CERTS:certificate},stdio:['ignore',output,output]});
  closeSync(output);let failed:Error|undefined;child.on('error',error=>{failed=error;});
  const stop=async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),new Promise<void>(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},5000))]);};
  try{
    for(let attempt=0;attempt<180;attempt++){
      if(failed||child.exitCode!==null)throw new Error('Published DSH startup failed; see local-dsh-native.log');
      const state=await(await runtime.dispatchFetch(url('alpha',base))).json() as {local?:{online:boolean}};
      if(state.local?.online)return {project,base,stop};
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('Local DSH did not connect; see local-dsh-native.log');
  }catch(error){await stop();throw error;}
}
