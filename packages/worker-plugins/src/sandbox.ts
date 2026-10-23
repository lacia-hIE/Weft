import type {Context} from '@deepseek-ai/cordis';
import type {} from '../../workspace/src/services.ts';
export const name = '@weft/worker-task-sandbox';
export const inject = ['weftWorkspaceServices'];
export function apply(ctx: Context) {
  const platform = ctx.weftWorkspaceServices;
  ctx.on('session/event', async (session, event) => {
    if (event.type === 'sandbox/mode' && event.data.mode === 'read-only') await platform.transport.revokeJavaScriptWrites(platform.scope, session.id);
  }, {global: true});
}
