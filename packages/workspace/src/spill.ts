import type { Context } from '@deepseek-ai/cordis';
import { SpillLocator, SpillStore, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill';
import type {} from '@deepseek-ai/dsh-fs';
import { encodeSegment, sessionDir } from '@weft/upstream/packages/spill/spill-local/src/store.ts';
import { MAX_FILE_BYTES } from './protocol.ts';

/** Where spilled text lands: a workspace directory the file tools can read and git ignores. */
export const SPILL_ROOT = '/workspace/.dsh/spill';
/** Bytes per stored part, under the workspace's single-write limit with room for multibyte characters. */
const PART_BYTES = MAX_FILE_BYTES - 4096;

/**
 * The spill storage seam over the environment's workspace: oversized text is
 * written under {@link SPILL_ROOT} in a Session-scoped directory, so the
 * model reads it back with the same file tools as any workspace file. Text
 * beyond one workspace write is stored as consecutive numbered parts in one
 * directory. Spilled files stay until removed from the workspace.
 */
export class WorkspaceSpillStore extends SpillStore {
  static inject = ['fs'];
  private ignored = false;

  constructor(ctx: Context) { super(ctx); }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    // Workspace files are UTF-8 text with LF line ends: the stored text is the content in that form.
    const content = input.content.replaceAll('\r\n', '\n').replaceAll('\0', '\uFFFD');
    const bytes = new TextEncoder().encode(content).byteLength;
    const name = `${crypto.randomUUID().slice(0, 12)}-${encodeSegment(input.suggestedName)}`;
    const directory = sessionDir(SPILL_ROOT, input.owner.sessionId);
    await this.ignore();
    const parts = split(content);
    if (parts.length === 1) {
      const path = `${directory}/${name}`;
      await this.write(path, content);
      return {locator: SpillLocator(path), bytes, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.'};
    }
    const folder = `${directory}/${name}`;
    const width = String(parts.length).length;
    for (const [index, part] of parts.entries()) await this.write(`${folder}/part-${String(index + 1).padStart(width, '0')}.txt`, part);
    return {
      locator: SpillLocator(folder), bytes,
      retrievalHint: `The text is split in order across ${parts.length} files in this directory (part-${'1'.padStart(width, '0')}.txt first). Use read with offset/limit on a part, or grep this directory to search all of it.`,
    };
  }

  private async write(path: string, content: string): Promise<void> {
    await this.ctx.fs.writeText(await this.ctx.fs.resolve(path), content);
  }

  /** Keep spilled text out of git status and change snapshots of a repository rooted at the workspace. */
  private async ignore(): Promise<void> {
    if (this.ignored) return;
    const target = await this.ctx.fs.resolve(`${SPILL_ROOT}/.gitignore`);
    if (!await this.ctx.fs.stat(target)) await this.ctx.fs.writeText(target, '*\n');
    this.ignored = true;
  }
}

/** Consecutive slices of `content`, each within {@link PART_BYTES} when UTF-8 encoded. */
function split(content: string): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(content).byteLength <= PART_BYTES) return [content];
  const parts: string[] = [];
  let start = 0;
  while (start < content.length) {
    // Each UTF-16 unit encodes to at most 3 bytes, so this many units always fit.
    let end = Math.min(content.length, start + Math.floor(PART_BYTES / 3));
    while (end < content.length && encoder.encode(content.slice(start, end + 1024)).byteLength <= PART_BYTES) end = Math.min(content.length, end + 1024);
    // Never split a surrogate pair.
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    parts.push(content.slice(start, end));
    start = end;
  }
  return parts;
}
