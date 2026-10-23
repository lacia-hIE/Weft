import type {Context} from '@deepseek-ai/cordis';
import type {} from '../../workspace/src/services.ts';
import {mountWorkerDocuments} from './index.ts';
import {Config, ID} from './config.ts';
export {Config};
export const name = '@weft/worker-documents-tool';
export const inject = ['tools', 'fs', 'workingDirectory', 'sandboxPolicy', 'weftWorkspaceServices'];
export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  const platform = ctx.weftWorkspaceServices;
  mountWorkerDocuments(ctx, platform.scope, {convertDocument: async (scope, name, bytes) => {
    const current = await platform.resolve(ID);
    if (!current || current.disabled) throw new Error('Worker document plugin is disabled');
    if (bytes.byteLength > Number(current.config.maxInputMiB) * 1048576) throw new Error('Document exceeds this environment’s input limit');
    return platform.transport.convertDocument(scope, name, bytes);
  }}, {get maxInputMiB() {return config.maxInputMiB.get();}, get previewCharacters() {return config.previewCharacters.get();}});
}
