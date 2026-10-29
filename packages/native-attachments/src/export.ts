import {posix} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {FileAttachmentRef, ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import {defineTool} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import {assistantStreamChunks} from '@deepseek-ai/dsh-llm';
import {workspacePath, type WorkspaceScope} from '../../workspace/src/protocol.ts';
import type {ShellSandbox} from '../../workspace/src/shell.ts';

export interface AttachmentExportTransport {
  exportAttachment(scope: WorkspaceScope, ref: FileAttachmentRef, destination: string, policy: ShellSandbox): Promise<Response>;
}
type Reference = {type: 'file'; attachment: FileAttachmentRef} | {type: 'image'; attachment: ImageAttachmentRef};

function contentRefs(value: unknown): Reference[] {
  if (!Array.isArray(value)) return [];
  return value.filter((part): part is Reference => part && typeof part === 'object' && ['file', 'image'].includes(part.type)
    && part.attachment && typeof part.attachment.attachmentId === 'string');
}
/** Declared content fields only: strings and arbitrary tool JSON never confer attachment authority. */
export function attachmentGroups(events: readonly SessionEvent[]): Reference[][] {
  return events.map(event => {
    const data = event.data as {content?: unknown; message?: {content?: unknown}; inserted?: {content?: unknown}[]; summary?: unknown; rawOutput?: unknown};
    switch (event.type as string) {
      case 'user/message': case 'tool/ptc-dispatch': return contentRefs(data.content);
      case 'system/message': case 'developer/message': case 'tool/result': case 'team/message/queued': return contentRefs(data.message?.content);
      case 'agent/inbox/spliced': return Array.isArray(data.inserted) ? data.inserted.flatMap(message => contentRefs(message.content)) : [];
      case 'compaction/summary': return [...contentRefs(data.summary), ...contentRefs(data.rawOutput)];
      case 'assistant/message': case 'assistant/attempt': {
        const refs = contentRefs(data.message?.content);
        if (refs.length || event.type === 'assistant/attempt') return refs;
        const assistant = event as SessionEvent<'assistant/message'>;
        return [...assistantStreamChunks(assistant.data.stream, 'block-end')].flatMap(chunk => contentRefs([chunk.block]));
      }
      default: return [];
    }
  }).filter(refs => refs.length);
}

export function mountAttachmentExport(ctx: Context, config: {scope: WorkspaceScope; transport: AttachmentExportTransport}): void {
  ctx.tools.register(defineTool({
    name: 'export_attachment',
    description: 'Copy an attachment referenced by this Session into a normal workspace file so shell, Python and image libraries can read its bytes. The private .weft directory cannot be read from the shell. Source may be an attachment ID or the exact attachment host path; omit it to select the single attachment in the latest attachment-bearing message (prefers original file over its normalized image). File bytes are preserved exactly; image-only references export the stored normalized WebP, not an unavailable original. Destination must be a new file inside the writable workspace. Maximum 64 MiB.',
    parameters: {source: {type: 'string', description: 'Attachment ID or exact host path from this Session.'}, destination: {type: 'string', required: true, description: 'New workspace file path, e.g. inputs/lobster.webp. Relative to this Session directory.'}},
    output: {schema: {type: 'json'}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
    execute: async (args: {source?: string; destination: string}, exec) => {
      exec.signal.throwIfAborted();
      const agent = exec.agent;
      if (!agent) throw new Error('Attachment export requires a calling Session.');
      const groups = attachmentGroups(agent.session.snapshotEvents());
      const hostPath = (ref: Reference) => ref.type === 'file' ? ctx.attachments.fileHostPath(ref.attachment) : ctx.attachments.imageHostPath(ref.attachment);
      let candidates = args.source ? groups.flat().filter(ref => String(ref.attachment.attachmentId) === args.source || hostPath(ref) === args.source) : groups.at(-1) ?? [];
      if (!args.source && candidates.some(ref => ref.type === 'file')) candidates = candidates.filter(ref => ref.type === 'file');
      candidates = [...new Map(candidates.map(ref => [ref.type + ':' + ref.attachment.attachmentId + ':' + hostPath(ref), ref])).values()];
      if (candidates.length !== 1) throw new Error(candidates.length ? 'Multiple attachments match. Supply the exact attachment host path.' : 'The source is not an attachment referenced by this Session.');
      const selected = candidates[0]!;
      const policy = agent.ctx.get('sandboxPolicy')?.resolve({session: agent.session});
      if (!policy) throw new Error('Attachment export requires the Session sandbox policy.');
      const cwd = agent.session.header.cwd ?? policy.workspaceRoot;
      const destination = workspacePath(posix.resolve(cwd, args.destination));
      const file: FileAttachmentRef = selected.type === 'file' ? selected.attachment : {attachmentId: selected.attachment.attachmentId, name: 'image.webp', bytes: selected.attachment.bytes};
      const response = await config.transport.exportAttachment(config.scope, file, destination, {mode: policy.mode, root: policy.workspaceRoot});
      const result = await response.json() as {value?: {path: string; bytes: number; attachmentId: string; version: string}; error?: string};
      exec.signal.throwIfAborted();
      if (!response.ok || !result.value) throw new Error(result.error ?? 'Attachment export failed.');
      return {...result.value, sourceType: selected.type, mediaType: selected.type === 'image' ? selected.attachment.mediaType : null};
    },
  }));
}
