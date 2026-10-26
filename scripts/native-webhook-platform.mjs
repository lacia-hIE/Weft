import {resolve} from 'node:path';

/** Replace only the in-process Agent action; retain upstream rule registry/lifecycle. */
export const nativeWebhookPlatform={name:'weft-worker-webhook-session',setup(builder){
  let replaced=false;builder.onStart(()=>{replaced=false;});
  builder.onResolve({filter:/^\.\/session\.ts$/},({importer})=>importer.endsWith('/experimental/webhook/src/index.ts')?(replaced=true,{path:resolve('packages/native-plugins/src/webhook-action.ts')}):undefined);
  builder.onEnd(()=>replaced?undefined:{errors:[{text:'The pinned webhook Session seam changed; review the Worker Host adapter'}]});
}};
