import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('spilled text beyond one workspace write is stored as ordered parts that rejoin to the stored text', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'weft-spill-'));
  // The bundle reads its attribution version from an adjacent package manifest, as the Worker build inlines it.
  await writeFile(join(scratch, 'package.json'), '{"version": "0.0.0"}');
  const bundle = join(scratch, 'host', 'host.mjs');
  await build({entryPoints: ['tests/fixtures/spill-host.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2024', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error'});
  const {Context, SessionId, ToolCallId, WorkspaceSpillStore, MAX_FILE_BYTES} = await import(pathToFileURL(bundle).href) as typeof import('./fixtures/spill-host.ts');
  const files = new Map<string, string>();
  const ctx = new Context();
  ctx.provide('fs', {
    resolve: async (path: string) => ({displayPath: path}),
    stat: async (target: {displayPath: string}) => files.has(target.displayPath) ? {type: 'file'} : undefined,
    writeText: async (target: {displayPath: string}, content: string) => {
      assert.ok(new TextEncoder().encode(content).byteLength <= MAX_FILE_BYTES, `${target.displayPath} exceeds one workspace write`);
      files.set(target.displayPath, content);
    },
  });
  await ctx.plugin(WorkspaceSpillStore);
  const line = 'résumé 😀 data\r\n';
  const content = line.repeat(40_000) + 'end\0';
  const save = (text: string) => ctx.spillStore.saveText({owner: {sessionId: SessionId('spill')}, source: {kind: 'tool', toolName: 'bash', callId: ToolCallId('call'), label: 'result'}, suggestedName: 'bash.txt', content: text});
  const ref = await save(content);
  const stored = content.replaceAll('\r\n', '\n').replaceAll('\0', '�');
  assert.equal(ref.bytes, new TextEncoder().encode(stored).byteLength);
  const parts = [...files.keys()].filter(path => path.startsWith(`${ref.locator}/part-`)).sort();
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  assert.equal(parts.map(path => files.get(path)).join(''), stored);
  assert.match(ref.retrievalHint, new RegExp(`split in order across ${parts.length} files`));
  assert.equal(files.get('/workspace/.dsh/spill/.gitignore'), '*\n');
  // Text within one write stays one file.
  const small = await save('small');
  assert.equal(files.get(small.locator), 'small');
  await ctx.fiber.dispose();
  await rm(scratch, {recursive: true, force: true});
});
