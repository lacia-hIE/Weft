import {build} from 'esbuild';
import {mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const directory = resolve('apps/workspace-container/.generated');
const upstream = JSON.parse(readFileSync('.generated/upstream-source.json', 'utf8')).directory;
mkdirSync(directory, {recursive: true});
await build({entryPoints: ['apps/workspace-container/process-service.mjs'], outfile: `${directory}/processd.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: '.generated/upstream.source.tsconfig.json',
  external: ['node-pty', 'koffi', 'ws', '@deepseek-ai/node-addon-system/*'],
  // Linux containers use the original fallback process/session owner when user-systemd is absent.
  banner: {js: 'import {createRequire as __weftRequire} from "node:module"; const require = __weftRequire(import.meta.url);'},
  plugins: [{name: 'container-native-addon-boundary', setup(builder) {
    builder.onResolve({filter: /^@deepseek-ai\/node-addon-system\//}, ({path}) => ({path, external: true}));
    builder.onLoad({filter: /packages\/llm\/llm\/src\/attribution\.ts$/}, ({path}) => {
      const source = readFileSync(path, 'utf8');
      const before = "const { version } = createRequire(import.meta.url)('../package.json') as { version: string }";
      if (!source.includes(before)) throw new Error('Upstream attribution seam changed');
      return {contents: source.replace(before, "const version = " + JSON.stringify(JSON.parse(readFileSync(resolve(upstream, 'package.json'), 'utf8')).version)), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onLoad({filter: /packages\/subprocess\/subprocess-local\/src\/runner-launch\.ts$/}, ({path}) => ({
      contents: readFileSync(path, 'utf8').replace("import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')", "new URL('./runner.mjs', import.meta.url).href"), loader: 'ts', resolveDir: resolve(path, '..'),
    }));
  }}], logLevel: 'warning'});
await build({stdin: {contents: `import {runSelectedSubprocessRunner} from ${JSON.stringify(resolve(upstream, 'packages/subprocess/subprocess-local/src/bin.ts'))};
import {consumeRunnerSelection} from ${JSON.stringify(resolve(upstream, 'packages/subprocess/subprocess-local/src/runner-launch.ts'))};
const selection = consumeRunnerSelection(); if (selection === undefined) process.exitCode = 127; else await runSelectedSubprocessRunner(selection);`, resolveDir: process.cwd()},
  outfile: `${directory}/runner.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: '.generated/upstream.source.tsconfig.json',
  external: ['koffi'], banner: {js: 'import {createRequire as __weftRequire} from "node:module"; const require = __weftRequire(import.meta.url);'}, logLevel: 'warning'});
