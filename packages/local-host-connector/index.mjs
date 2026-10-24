import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {connectLocalHost} from './transport.mjs';
export const name='weft-local-host';
export const inject=['webServer','connection','clientModules'];
/** This is a normal native Host plugin. It never implements a second Agent. */
export async function apply(ctx,config={}) {
  const file=config.connectionFile??process.env.WEFT_LOCAL_HOST_CONFIG??join(homedir(),'.dsh','weft-connection.json');
  let settings;try{settings=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('Save your Weft connection file and set WEFT_LOCAL_HOST_CONFIG before enabling this plugin');}
  const version=ctx.clientModules.graph().release.version;
  if(version!=='0.2.1-rc.2')throw new Error('Weft local Host requires DSH 0.2.1-rc.2');
  const origin=ctx.webServer.getOrigin();
  const url=new URL(origin);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Use a loopback DSH web listener for the Weft connector');
  const save=async value=>{
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,file);settings=value;
  };
  // Obtain a local browser cookie from the native launch-token exchange. It
  // stays inside this process and is never sent through the relay.
  const authorize=async()=>{
    const response=await fetch(ctx.connection.authenticatedUrl(origin+'/'),{redirect:'manual',signal:AbortSignal.timeout(15_000)});
    await response.body?.cancel();
    const cookie=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
    if(response.status!==302||!cookie)throw new Error('Native DSH browser authentication failed');return cookie;
  };
  ctx.effect(()=>connectLocalHost({settings,save,origin,authorize,version,onStatus:status=>ctx.logger.info(`Weft local Host: ${status}`)}),'weft-local-host-connection');
}
