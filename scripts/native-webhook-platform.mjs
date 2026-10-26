import {resolve} from 'node:path';

/** Replace only the in-process Agent action; retain upstream rule registry/lifecycle. */
export const nativeWebhookPlatform={name:'weft-worker-webhook-session',setup(builder){
  builder.onResolve({filter:/^\.\/session\.ts$/},({importer})=>importer.endsWith('/experimental/webhook/src/index.ts')?{path:resolve('packages/native-plugins/src/webhook-action.ts')}:undefined);
}};
