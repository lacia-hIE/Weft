import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

test('IM labels retain native automatic title revisions and manual pins without labeling inherited or ordinary prompts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-im-titles-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"version":"0.0.0"}');
    const outfile = join(directory, 'host', 'titles.mjs');
    await build({entryPoints: ['tests/fixtures/im-session-titles.ts'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'es2024', tsconfig: '.generated/upstream.source.tsconfig.json', logLevel: 'error'});
    const host = await import(pathToFileURL(outfile).href) as typeof import('./fixtures/im-session-titles.ts');
    await host.verifyImSessionTitles();
  } finally {await rm(directory, {recursive: true, force: true});}
});
