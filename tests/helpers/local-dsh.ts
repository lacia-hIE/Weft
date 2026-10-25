import {mkdtempSync,mkdirSync,writeFileSync,openSync,closeSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import type {Miniflare} from 'miniflare';
import {tenantId,url} from './miniflare.ts';
import {LOCAL_HOST_BUNDLE} from '../../packages/local-host-connector/compatibility.mjs';
/** CI-only fixture: start the published, unmodified DSH with our real plugin. */
export async function startLocalDsh(runtime:Miniflare,certificate:string):Promise<{project:string;base:string;localUrl:string;pairingCode:string;stop:()=>Promise<void>;restart:()=>Promise<void>}> {
  const root=mkdtempSync(join(tmpdir(),'weft-local-dsh-')),project=join(root,'project');mkdirSync(project);
  writeFileSync(join(project,'notes.md'),'# Local project\n\nLOCAL_DSH_FILE\n');
  execFileSync('git',['init','--initial-branch=main',project]);execFileSync('git',['-C',project,'add','.']);
  execFileSync('git',['-C',project,'-c','user.name=CI','-c','user.email=ci@example.invalid','commit','-m','Initial project']);
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const tenant=tenantId('alpha'),base=`/v1/tenants/${tenant}/environments/native-local-ci`;
  const post=(path:string,body:unknown)=>runtime.dispatchFetch(url('alpha',path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if((await post(`/v1/tenants/${tenant}/environments`,{id:'native-local-ci',name:'Native local CI',kind:'local'})).status!==201)throw new Error('Could not register local fixture');
  const {pairingKey}=await(await post(base+'/local/pairing',{})).json() as {pairingKey:string};
  const file=join(root,'connection.json');
  const pairingCode=Buffer.from(JSON.stringify({endpoint:`https://127.0.0.1:4173/v1/local-hosts/${tenant}/native-local-ci`,pairingKey})).toString('base64url');
  const executable=resolve('.generated/local-dsh/node_modules/.bin/dsh');
  const environment={...process.env,DSH_HOME:join(root,'home'),DSH_AGENTS_HOME:join(root,'agents'),WEFT_LOCAL_HOST_CONFIG:file,NODE_EXTRA_CA_CERTS:certificate};
  const output=openSync('.generated/local-dsh-native.log','w');
  try{execFileSync(executable,['plugin','--profile','web','add',resolve('dist/public/downloads',LOCAL_HOST_BUNDLE)],{cwd:project,env:environment,stdio:['ignore',output,output],timeout:120_000});}finally{closeSync(output);}
  // Retain useful diagnostics without uploading native launch credentials.
  let trace=readFileSync('.generated/local-dsh-native.log','utf8');
  const log=(chunk:Buffer)=>{trace=(trace+chunk.toString()).slice(-2*1024*1024);writeFileSync('.generated/local-dsh-native.log',trace.replace(/([?&]token=)[^\s\x1b"<>]+/g,'$1[redacted]'),{mode:0o600});};
  let child!:ChildProcess,failed:Error|undefined;
  const launch=()=>{failed=undefined;child=spawn(executable,['--profile','web','--no-open','--port',String(port)],{cwd:project,env:environment,stdio:['ignore','pipe','pipe']});child.stdout?.on('data',log);child.stderr?.on('data',log);child.on('error',error=>{failed=error;});};
  launch();
  const stop=async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),new Promise<void>(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},5000))]);};
  const restart=async()=>{await stop();launch();for(let attempt=0;attempt<180;attempt++){if(failed||child.exitCode!==null)throw new Error('Native restart failed');const state=await(await runtime.dispatchFetch(url('alpha',base))).json() as {local?:{online:boolean}};if(state.local?.online)return;await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('Native Host did not reconnect');};
  try{
    for(let attempt=0;attempt<180;attempt++){
      if(failed||child.exitCode!==null)throw new Error('Published DSH startup failed; see local-dsh-native.log');
      const localUrl=trace.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s\x1b"<>]*[?&]token=[A-Za-z0-9._~%+-]+/)?.[0];
      if(localUrl){const ready=await fetch(`http://127.0.0.1:${port}/api/weft-local-host`).catch(()=>undefined);await ready?.body?.cancel();if(ready?.status===401)return {project,base,stop,restart,localUrl,pairingCode};}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('Local DSH did not start; see local-dsh-native.log');
  }catch(error){await stop();throw error;}
}
