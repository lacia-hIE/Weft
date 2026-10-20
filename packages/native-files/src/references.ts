import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types';
import { posix } from 'node:path';
import LocalFileReferenceService from '@deepseek-ai/dsh-file-reference-local';
import { DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_RESULTS } from '@weft/upstream/packages/context/file-reference-local/src/search.ts';

// Each directory read is a WorkspaceDO round trip; bound a bare-query index well below the local default.
const MAX_ENTRIES = 5_000;

/**
 * The original `@` file-reference service (its prompt section, config and
 * ranking rules) enumerating the environment's Computer volume through
 * `ctx.fs` instead of host `node:fs`.
 */
export class ComputerFileReferences extends LocalFileReferenceService {
  static override inject = ['agents', 'workingDirectory', 'fs'];
  private readonly indexes = new Map<string, {entries: Promise<FileReferenceCandidate[]>; stale: boolean}>();

  constructor(ctx: Context) {
    super(ctx, {});
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result') for (const index of this.indexes.values()) index.stale = true;
    });
  }

  override async list(agent: Agent, rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal);
    const query = rawQuery.replaceAll('\\', '/');
    const slash = query.lastIndexOf('/');
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1);
      const fragment = slash < 0 ? '' : query.slice(slash + 1);
      if (directory.split('/').some(segment => excluded.has(segment)) || directory.split('/').includes('..')) return [];
      const entries = await this.read(posix.join(cwd, directory), signal);
      const candidates = entries.filter(entry => !(entry.name.startsWith('.') && !fragment.startsWith('.')))
        .map(entry => ({path: directory + entry.name, kind: entry.kind}));
      return rank(candidates, fragment);
    }
    // Traversals outlive one caller's cancellation; a stale index keeps answering while its replacement builds.
    let index = this.indexes.get(cwd);
    if (!index) this.indexes.set(cwd, index = {entries: this.scan(cwd, new AbortController().signal), stale: false});
    else if (index.stale) {
      const current = index;
      current.stale = false;
      void this.scan(cwd, new AbortController().signal).then(entries => {current.entries = Promise.resolve(entries);}, () => {current.stale = true;});
    }
    const entries = await index.entries.catch(() => {this.indexes.delete(cwd); return [];});
    signal.throwIfAborted();
    return rank(entries.filter(candidate => visible(candidate.path, query)), query);
  }

  private async read(directory: string, signal: AbortSignal): Promise<{name: string; kind: 'file' | 'directory'}[]> {
    try {
      const entries = await this.ctx.fs.listDir(await this.ctx.fs.resolve(directory, {signal}), signal);
      return entries.flatMap(entry => entry.type === 'other' || (entry.type === 'directory' && excluded.has(entry.name)) ? [] : [{name: entry.name, kind: entry.type}])
        .sort((left, right) => compare(left.name, right.name));
    } catch {
      // A missing or unreadable branch contributes no candidates; autocomplete is advisory.
      signal.throwIfAborted();
      return [];
    }
  }

  private async scan(root: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const indexed: FileReferenceCandidate[] = [];
    const queue = [''];
    for (let cursor = 0; cursor < queue.length && indexed.length < MAX_ENTRIES; cursor++) {
      const relative = queue[cursor]!;
      for (const entry of await this.read(posix.join(root, relative), signal)) {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        indexed.push({path, kind: entry.kind});
        if (entry.kind === 'directory') queue.push(path);
        if (indexed.length >= MAX_ENTRIES) break;
      }
    }
    return indexed;
  }
}

const excluded = new Set<string>(DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES);

// The ranking below follows `file-reference-local/src/search.ts`, whose helpers are module-private.
function visible(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true;
  return !path.split('/').some(segment => segment.startsWith('.'));
}

function rank(candidates: readonly FileReferenceCandidate[], query: string): FileReferenceCandidate[] {
  return candidates.flatMap(candidate => {const score = scoreOf(candidate, query); return score === undefined ? [] : [{candidate, score}];})
    .sort((left, right) => right.score - left.score
      || (left.candidate.kind === 'directory' ? 0 : 1) - (right.candidate.kind === 'directory' ? 0 : 1)
      || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
      || compare(left.candidate.path, right.candidate.path))
    .slice(0, DEFAULT_FILE_SEARCH_MAX_RESULTS).map(entry => entry.candidate);
}

function scoreOf(candidate: FileReferenceCandidate, query: string): number | undefined {
  if (query === '') return 0;
  const path = candidate.path.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const needle = query.toLowerCase();
  const bonus = candidate.kind === 'directory' ? 25 : 0;
  if (name === needle) return 1_000 + bonus;
  if (name.startsWith(needle)) return 900 + bonus;
  if (name.includes(needle)) return 700 + bonus;
  if (path.includes(needle)) return 500 + bonus;
  let index = 0, gap = 0;
  for (const character of needle) {
    const found = path.indexOf(character, index);
    if (found < 0) return undefined;
    gap += found - index;
    index = found + 1;
  }
  return 300 + Math.max(0, 100 - gap) + bonus;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
