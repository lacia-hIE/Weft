import type {Context} from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import FileUploads from '@deepseek-ai/dsh-client-file-upload';
import {ApiSessionList} from '@weft/upstream/packages/api/session-controller/src/list.ts';
import {ComputerAttachmentStore, type AttachmentTransport} from './store.ts';
import {DurableUploadRegistry} from './receipts.ts';
import {AuthenticatedFetchRoutes} from './routes.ts';
import type {WorkspaceScope} from '../../workspace/src/protocol.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    weftConnectionRoutes: AuthenticatedFetchRoutes;
    weftNativeUploadRegistry: DurableUploadRegistry;
  }
}

export async function mountNativeAttachments(ctx: Context, config: {storage: DurableObjectStorage; scope: WorkspaceScope; sessionId: string; transport: AttachmentTransport}): Promise<void> {
  await ctx.plugin(ComputerAttachmentStore, config);
  await ctx.plugin(Commands);
  await ctx.plugin(AuthenticatedFetchRoutes);
  ctx.provide('weftNativeUploadRegistry', new DurableUploadRegistry(config.storage, config.sessionId));
  await ctx.plugin(FileUploads);
  new ApiSessionList(ctx, 8);
}
