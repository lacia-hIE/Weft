import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

export function prepareAttachmentHelpers(upstreamDirectory) {
  const files = readFileSync(resolve(upstreamDirectory, 'packages/attachment/attachment-local/src/file-store.ts'), 'utf8');
  const start = files.indexOf('const FILE_ID_PATTERN =');
  const end = files.indexOf('/**\n * Commit one file byte-for-byte below', start);
  if (start < 0 || end < 0) throw new Error('Upstream file-reference helpers changed; review attachment adaptation');
  writeFileSync('.generated/official-file-reference.ts', "import {join} from 'node:path';\nimport {AttachmentError} from '@deepseek-ai/dsh-attachment';\nimport type {FileAttachmentRef} from '@deepseek-ai/dsh-attachment';\n" + files.slice(start, end));
  const commands = readFileSync(resolve(upstreamDirectory, 'packages/api/session-controller/src/commands.ts'), 'utf8');
  const from = commands.indexOf('function resolvePromptFileReceipts(');
  const to = commands.indexOf('\nfunction hasPromptRequest(', from);
  if (from < 0 || to < 0) throw new Error('Upstream prompt receipt resolution changed; review attachment admission');
  writeFileSync('.generated/official-prompt-files.ts', "import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';\nimport type {AttachmentAdmissionPart, FileAttachmentRef} from '@deepseek-ai/dsh-attachment';\nimport type {FileUploadReceiptId} from '@deepseek-ai/dsh-client-file-upload/types';\nimport type {SessionPromptRequest} from '@deepseek-ai/dsh-api-session-controller/types';\nexport " + commands.slice(from, to) + '\n');
  const imageStore = readFileSync(resolve(upstreamDirectory, 'packages/attachment/attachment-local/src/store.ts'), 'utf8');
  const nameFrom = imageStore.indexOf('function displayName(');
  const nameTo = imageStore.indexOf('\nfunction ensureReference(', nameFrom);
  const imageFrom = commands.indexOf('function imageBlockIn(');
  if (nameFrom < 0 || nameTo < 0 || imageFrom < 0 || !commands.slice(imageFrom).includes('function referencedImage(')) throw new Error('Upstream image authorization helpers changed; review the adaptation');
  writeFileSync('.generated/official-image-helpers.ts', "import {assistantStreamChunks} from '@deepseek-ai/dsh-llm';\nimport type {SessionEvent} from '@deepseek-ai/dsh-session';\nimport type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';\n" + imageStore.slice(nameFrom, nameTo).replace('function displayName(', 'export function imageDisplayName(') + '\n' + commands.slice(imageFrom).replace('function referencedImage(', 'export function referencedImage('));

}

/** Keep native receipts/commands intact; replace lifetime and physical HTTP transport. */
export const nativeAttachmentsPlatform = {
  name: 'harness-native-attachments-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/client\/file-upload\/src\/index\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      for (const [before, after] of [
        ["static inject = ['agents', 'attachments', 'commands', 'connection']", "static inject = ['agents', 'attachments', 'commands', 'weftConnectionRoutes']"],
        ['private readonly stagedFiles = new WeakMap<Session, Map<FileUploadReceiptId, StagedFileUpload>>()', 'private readonly stagedFiles = this.ctx.weftNativeUploadRegistry'],
        ['ctx.connection.fetch.register({', 'ctx.weftConnectionRoutes.register({'],
        ['let staged = this.stagedFiles.get(agent.session)\n    if (staged === undefined) {\n      staged = new Map()\n      this.stagedFiles.set(agent.session, staged)\n    }', 'const staged = this.stagedFiles.get(agent.session)'],
      ]) {
        if (!source.includes(before)) throw new Error('Upstream FileUploads platform seam changed; review the workerd adaptation');
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
  },
};
