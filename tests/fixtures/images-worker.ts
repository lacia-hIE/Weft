import {Context} from '@deepseek-ai/cordis';
import {Workspace} from '@cloudflare/computer';
import {AttachmentError, type ImageAttachmentRef, type ImageRequestTarget} from '@deepseek-ai/dsh-attachment';
import {WorkspaceDO as BaseWorkspaceDO} from '../../packages/workspace/src/object.ts';
import {workspaceAddress, type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
import {ComputerAttachmentStore} from '../../packages/native-attachments/src/store.ts';
import {ATTACHMENT_ROOT} from '../../packages/native-attachments/src/protocol.ts';
import {storedFilePath} from '../../.generated/official-file-reference.ts';
import {IMAGE_LIMITS} from '../../packages/native-attachments/src/image-policy.ts';
import {z} from 'zod';

/** Test-only corruption injection; never exported by the application Worker. */
export class WorkspaceDO extends BaseWorkspaceDO {
  async corrupt(scope: WorkspaceScope, ref: ImageAttachmentRef): Promise<void> {
    if (!this.ctx.id.equals(this.env.WORKSPACES.idFromName(workspaceAddress(scope)))) throw new Error('Scope mismatch');
    const fs = new Workspace({storage: this.ctx.storage, output: false}).provider();
    fs.writeRangeSync(storedFilePath(ATTACHMENT_ROOT, {attachmentId: ref.attachmentId, name: 'image.webp', bytes: ref.bytes}), new Uint8Array([255]), 0);
    await this.ctx.storage.sync();
  }
}
interface Env {IMAGES: ImagesBinding; WORKSPACES: DurableObjectNamespace<WorkspaceDO>}

/** Local cf dev entrypoint with a real remote Images binding and actual Computer storage. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('Native image validation');
    const url = new URL(request.url);
    const scope = {tenantId: 'image-validation', environmentId: url.searchParams.get('environment') ?? 'one', workspaceId: 'default'};
    const transport = env.WORKSPACES.getByName(workspaceAddress(scope));
    const ctx = new Context();
    let codecCalls = 0;
    const images = {
      info: (...args: Parameters<ImagesBinding['info']>) => {codecCalls++; return env.IMAGES.info(...args);},
      input: (...args: Parameters<ImagesBinding['input']>) => {codecCalls++; return env.IMAGES.input(...args);},
    };
    try {
      await ctx.plugin(ComputerAttachmentStore, {scope, sessionId: 'images', transport, ...(url.searchParams.get('codec') === 'off' ? {} : {images})});
      const mode = url.searchParams.get('mode') ?? 'normalize';
      if (mode === 'binding-info') return Response.json({info: await env.IMAGES.info(request.body!)});
      if (mode === 'normalize') {
        const ref = await ctx.attachments.saveImage({data: new Uint8Array(await request.arrayBuffer()), mediaType: z.enum(IMAGE_LIMITS.mediaTypes).parse(url.searchParams.get('type')), name: url.searchParams.get('name') ?? 'fixture'});
        const stored = await ctx.attachments.readImage(ref);
        return Response.json({ref, data: Buffer.from(stored.data).toString('base64'), path: ctx.attachments.imageHostPath(ref), codecCalls});
      }
      const input = await request.json() as {ref: ImageAttachmentRef; target: ImageRequestTarget};
      if (mode === 'corrupt') {await transport.corrupt(scope, input.ref); return Response.json({corrupted: true});}
      if (mode === 'read') {
        const stored = await ctx.attachments.readImage(input.ref);
        return Response.json({ref: stored.ref, data: Buffer.from(stored.data).toString('base64'), codecCalls});
      }
      if (mode === 'project') {
        const version = await ctx.attachments.readImageRequest(input.ref, input.target);
        return Response.json({...version, data: Buffer.from(version.data).toString('base64'), codecCalls});
      }
      return new Response('Unknown validation operation', {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'Image validation failed', code: error instanceof AttachmentError ? error.code : error instanceof Error && 'code' in error ? error.code : 'INTERNAL', diagnostic: error instanceof Error && error.cause instanceof Error ? {message: error.cause.message, code: 'code' in error.cause ? error.cause.code : undefined} : undefined}, {status: 400});
    } finally {await ctx.fiber.dispose();}
  },
};
