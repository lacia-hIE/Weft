/** Node test host for the production Worker adapter; all children still run in Docker. */
import {Context} from '@deepseek-ai/cordis';
import {WorkspaceSubprocess, type ShellTransport} from '../../packages/workspace/src/subprocess.ts';
export {WorkspaceStore} from '../../packages/workspace/src/store.ts';
export {ContainerProcessClient} from '../../packages/workspace/src/process-client.ts';
export {discoverShells} from '@weft/upstream/packages/api/terminal-controller/src/shells.ts';
export async function boot(transport: ShellTransport) {
  const ctx = new Context();
  await ctx.plugin(WorkspaceSubprocess, transport);
  return {ctx, subprocess: ctx.subprocess};
}
