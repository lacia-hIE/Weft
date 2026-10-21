import type { Context } from '@deepseek-ai/cordis';
import { SpillLocator, SpillStore, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill';
import type FileSystem from '@deepseek-ai/dsh-fs';
import { encodeSegment, sessionDir } from '@weft/upstream/packages/spill/spill-local/src/store.ts';
import { MAX_FILE_BYTES } from './protocol.ts';

/** Where spilled text lands: a workspace directory the file tools can read and git ignores. */
export const SPILL_ROOT = '/workspace/.dsh/spill';
/** Bytes per stored part, under the workspace's single-write limit with room for multibyte characters. */
const PART_BYTES = MAX_FILE_BYTES - 4096;

/** One stored text: its workspace path, stored byte length, and how many ordered parts hold it (1 is a single file). */
export interface StoredText { path: string; bytes: number; parts: number }

/**
 * Store text under {@link SPILL_ROOT}: a single file at `file` when it fits
 * one workspace write, otherwise consecutive `part-N.txt` files in
 * `directory`. Workspace files are UTF-8 text with LF line ends, so
 * the stored text is the content in that form (NUL becomes U+FFFD).
 */
export async function storeText(fs: FileSystem, file: string, directory: string, text: string): Promise<StoredText> {
  const content = text.replaceAll('\r\n', '\n').replaceAll('\0', '�');
  const bytes = new TextEncoder().encode(content).byteLength;
  const write = async (file: string, value: string) => { await fs.writeText(await fs.resolve(file), value); };
  // Keep spilled text out of git status and change snapshots of a repository rooted at the workspace.
  const ignore = await fs.resolve(`${SPILL_ROOT}/.gitignore`);
  if (!await fs.stat(ignore)) await fs.writeText(ignore, '*\n');
  const parts = split(content);
  if (parts.length === 1) {
    await write(file, content);
    return {path: file, bytes, parts: 1};
  }
  const width = String(parts.length).length;
  for (const [index, part] of parts.entries()) await write(`${directory}/part-${String(index + 1).padStart(width, '0')}.txt`, part);
  return {path: directory, bytes, parts: parts.length};
}

/** Retrieval guidance for a {@link StoredText}. */
export function retrievalHint(stored: StoredText): string {
  if (stored.parts === 1) return 'Use read with offset/limit, or grep this path to search within it.';
  const first = '1'.padStart(String(stored.parts).length, '0');
  return `The text is split in order across ${stored.parts} files in this directory (part-${first}.txt first). Use read with offset/limit on a part, or grep this directory to search all of it.`;
}

/**
 * The spill storage seam over the environment's workspace: oversized text is
 * written under {@link SPILL_ROOT} in a Session-scoped directory, so the
 * model reads it back with the same file tools as any workspace file.
 * Spilled files stay until removed from the workspace.
 */
export class WorkspaceSpillStore extends SpillStore {
  static inject = ['fs'];

  constructor(ctx: Context) { super(ctx); }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const name = `${crypto.randomUUID().slice(0, 12)}-${encodeSegment(input.suggestedName)}`;
    const path = `${sessionDir(SPILL_ROOT, input.owner.sessionId)}/${name}`;
    const stored = await storeText(this.ctx.fs, path, path.replace(/\.txt$/, ''), input.content);
    return {locator: SpillLocator(stored.path), bytes: stored.bytes, retrievalHint: retrievalHint(stored)};
  }
}

/** Consecutive slices of `content`, each within {@link PART_BYTES} when UTF-8 encoded; a surrogate pair is never split. */
function split(content: string): string[] {
  const parts: string[] = [];
  let start = 0, bytes = 0;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    const pair = code >= 0xD800 && code <= 0xDBFF && index + 1 < content.length;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > PART_BYTES) { parts.push(content.slice(start, index)); start = index; bytes = 0; }
    bytes += size;
    if (pair) index++;
  }
  parts.push(content.slice(start));
  return parts;
}
