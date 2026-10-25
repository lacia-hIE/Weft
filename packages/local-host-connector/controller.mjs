import {readFile,writeFile,rename,mkdir,chmod,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {connectLocalHost,validateEndpoint} from './transport.mjs';

/** One native plugin instance owns configuration, connection and disposal. */
export function createController({file,origin,authorize,version,connect=connectLocalHost}) {
  let settings,dispose,closed=false,work=Promise.resolve();
  let status={state:'unpaired',changedAt:Date.now()};
  const update=state=>{if(!closed)status={state,changedAt:Date.now(),...(state==='connected'?{connectedAt:Date.now()}:{} )};};
  const serial=action=>{const next=work.then(action);work=next.catch(()=>{});return next;};
  const save=async value=>{
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const temporary=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,file);settings=value;}
    finally{await unlink(temporary).catch(()=>{});}
  };
  const stop=async()=>{const release=dispose;dispose=undefined;await release?.();};
  const start=()=>{
    if(closed||!settings)return;
    validateEndpoint(settings.endpoint);
    dispose=connect({settings,save,origin,authorize,version,onStatus:update});
  };
  const load=async()=>{
    try{
      const value=JSON.parse(await readFile(file,'utf8'));validateEndpoint(value.endpoint);
      if(!/^[a-f0-9]{64}$/.test(value.token??value.pairingKey??''))throw new Error('Invalid credential');
      settings=value;start();
    }catch(error){settings=undefined;update(error.code==='ENOENT'?'unpaired':'configuration-error');}
  };
  return {
    snapshot:()=>({...status,configured:Boolean(settings),endpoint:settings?.endpoint,hostVersion:version}),
    load:()=>serial(load),
    pair:code=>serial(async()=>{
      if(closed)throw new Error('Plugin stopped');
      if(typeof code!=='string'||code.length>8192)throw new Error('Invalid pairing code');
      let value;try{value=JSON.parse(code.trim().startsWith('{')?code:Buffer.from(code.trim(),'base64url').toString('utf8'));}catch{throw new Error('Invalid pairing code');}
      const endpoint=validateEndpoint(value.endpoint).href;
      if(!/^[a-f0-9]{64}$/.test(value.pairingKey??''))throw new Error('Invalid pairing key');
      await stop();await save({endpoint,pairingKey:value.pairingKey});start();
    }),
    reconnect:()=>serial(async()=>{if(closed)throw new Error('Plugin stopped');await stop();await load();}),
    disconnect:()=>serial(async()=>{await stop();update('stopped');}),
    close:()=>serial(async()=>{closed=true;await stop();}),
  };
}
