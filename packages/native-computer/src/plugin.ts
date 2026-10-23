import type {Context} from '@deepseek-ai/cordis';
import type {} from '../../workspace/src/services.ts';
import {mountComputerJavaScript} from './index.ts';
import {Config, ID} from './config.ts';
export {Config};
export const name = '@weft/worker-javascript-tool';
export const inject = ['tools', 'sandboxPolicy', 'workingDirectory', 'approval', 'weftWorkspaceServices'];
export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  const platform = ctx.weftWorkspaceServices;
  mountComputerJavaScript(ctx, platform.scope, {
    revokeJavaScriptWrites: (scope, owner) => platform.transport.revokeJavaScriptWrites(scope, owner),
    javascript: async (scope, owner, request) => {
      if (request.operation === 'start' || request.operation === 'answer') {
        const current = await platform.resolve(ID);
        if (!current || current.disabled) throw new Error('Worker JavaScript plugin is disabled');
        if (request.operation === 'start' && request.writable && current.config.allowWritable !== true) throw new Error('Writable JavaScript tasks are disabled');
      }
      return platform.transport.javascript(scope, owner, request);
    },
  }, {get defaultTimeoutMs() {return config.defaultTimeoutMs.get();}, get allowWritable() {return config.allowWritable.get();}});
}
