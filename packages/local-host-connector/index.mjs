import {join} from 'node:path';
import {homedir} from 'node:os';
import {createController} from './controller.mjs';
import {supportsDshVersion,SUPPORTED_DSH_VERSIONS} from './compatibility.mjs';
export const name='weft-local-host';
export const inject=['webServer','connection','clientModules'];
/** This is a normal native Host plugin. It never implements a second Agent. */
export async function apply(ctx,config={}) {
  const version=ctx.clientModules.graph()?.release?.version;
  if(!supportsDshVersion(version))throw new Error(`Weft local Host supports DSH ${SUPPORTED_DSH_VERSIONS.join(', ')}; received ${version??'an older Host without release identity'}. Update DSH with npm install -g @deepseek-ai/dsh@${SUPPORTED_DSH_VERSIONS.at(-1)}, then restart dsh web and enable this plugin.`);
  const file=config.connectionFile??process.env.WEFT_LOCAL_HOST_CONFIG??join(homedir(),'.dsh','weft-connection.json');
  const origin=ctx.webServer.getOrigin();
  const url=new URL(origin);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Use a loopback DSH web listener for the Weft connector');
  // Obtain a local browser cookie from the native launch-token exchange. It
  // stays inside this process and is never sent through the relay.
  const authorize=async()=>{
    const response=await fetch(ctx.connection.authenticatedUrl(origin+'/'),{redirect:'manual',signal:AbortSignal.timeout(15_000)});
    await response.body?.cancel();
    const cookie=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
    if(![302,303].includes(response.status)||!cookie)throw new Error('Native DSH browser authentication failed');return cookie;
  };
  const controller=createController({file,origin,authorize,version});
  ctx.effect(()=>()=>controller.close(),'weft-local-host-connection');
  // Native admission keeps local authentication, Host and Origin checks intact.
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/weft-local-host',handler:async(req,res)=>{
    const admission=ctx.connection.admit(req);
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    if('rejection' in admission){reply(admission.rejection,{error:'Unauthorized'});return;}
    if(admission.peer.principal.kind!=='owner'){reply(403,{error:'Owner access required'});return;}
    if(req.method==='GET'){reply(200,controller.snapshot());return;}
    if(req.method!=='POST'){reply(405,{error:'Method not allowed'});return;}
    try{
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>10_000){reply(413,{error:'Pairing request too large'});return;}}
      const value=JSON.parse(body);
      if(value.action==='pair')await controller.pair(value.code);
      else if(value.action==='reconnect')await controller.reconnect();
      else if(value.action==='disconnect')await controller.disconnect();
      else{reply(400,{error:'Unknown connection action'});return;}
      reply(200,controller.snapshot());
    }catch{reply(400,{error:'Check the pairing code and try again'});}
  }}),'weft-local-host-settings');
  await controller.load();
}
