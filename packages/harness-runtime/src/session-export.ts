import type {Context} from '@deepseek-ai/cordis';
import * as SessionLogExport from '@deepseek-ai/dsh-session-log-export';
import type {ConnectionFetchRoute} from '@weft/upstream/packages/client/connection/src/rpc.ts';
import type {} from '../../native-attachments/src/index.ts';

/** Keep the original command, archive format and streaming route behind the authenticated DO transport. */
async function SessionExportHost(ctx: Context): Promise<void> {
  ctx.provide('connection', {fetch: {register: (route: ConnectionFetchRoute) => ctx.effect(() => ctx.weftConnectionRoutes.register(route))}});
  await ctx.plugin(SessionLogExport);
}
SessionExportHost.inject = ['commands', 'weftConnectionRoutes'];

export async function mountSessionExport(ctx: Context): Promise<void> {
  await ctx.isolate('connection').plugin(SessionExportHost);
}
