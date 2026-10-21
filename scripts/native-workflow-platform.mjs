import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';

/**
 * The official workflow engine compiles the model's script with `node:vm`: the
 * host parses it before publishing a run, and the guest evaluates it in a
 * fresh context inside the PTC process. Workers evaluate no source at
 * runtime, so in Weft the script body becomes part of the PTC program itself
 * (one module, compiled when its Dynamic Worker loads), the guest's `vm`
 * calls receive that compiled function, and the host parse uses acorn.
 * Everything else — limits, children, progress, results — is the official code.
 */

/** The guest's `node:vm`: the run's compiled script stands in for `Script`. */
const GUEST_VM = `
let script;
export function provideWorkflowScript(fn) { script = fn; }
export function createContext(value) { return value; }
export class Script {
  constructor() {
    if (typeof script !== 'function') throw new Error('workflow script was not compiled into this program');
    this.script = script;
  }
  runInContext(context) {
    return this.script(context.agent, context.parallel, context.pipeline, context.phase, context.log, context.args);
  }
}`;

/** The workflow body as a function in the PTC program; the official guest supplies its globals. */
const PROGRAM = `function weftWorkflowProgram(body) {
  return \`const { runWorkflowGuest } = await import(\${JSON.stringify(GUEST_URL)});\\nreturn await runWorkflowGuest(workflowHost, async function (agent, parallel, pipeline, phase, log, args) {\\n\${body}\\n});\`
}`;

function patch(path, replacements) {
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Upstream workflow seam changed in ${path}: ${before.slice(0, 60)}`);
    source = source.replace(before, after);
  }
  return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
}

async function guestSource(guest, plugins) {
  const result = await build({
    entryPoints: [guest], bundle: true, format: 'esm', platform: 'neutral', target: 'es2024', write: false, minify: true,
    external: ['node:*'], mainFields: ['module', 'main'], tsconfig: '.generated/upstream.source.tsconfig.json',
    plugins: [...plugins, {
      name: 'weft-workflow-guest',
      setup(builder) {
        builder.onResolve({filter: /^node:vm$/}, () => ({path: 'weft-workflow-vm', namespace: 'weft-workflow'}));
        builder.onLoad({filter: /.*/, namespace: 'weft-workflow'}, () => ({contents: GUEST_VM, loader: 'js'}));
        builder.onLoad({filter: /packages\/workflow\/workflow-ptc\/src\/guest\.ts$/}, ({path}) => patch(path, [
          ["import { renderThrown } from './realm.ts'", "import { renderThrown } from './realm.ts'\nimport { provideWorkflowScript } from 'node:vm'"],
          ['export async function runWorkflowGuest(host: WorkflowGuestHost): Promise<WorkflowResult> {', 'export async function runWorkflowGuest(host: WorkflowGuestHost, script: (...globals: unknown[]) => Promise<unknown>): Promise<WorkflowResult> {\n  provideWorkflowScript(script)'],
        ]));
      },
    }],
  });
  return result.outputFiles[0].text;
}

/** @param guestPlugins - the Worker build's own source adaptations, applied to the guest bundle too. */
export const nativeWorkflowPlatform = guestPlugins => ({
  name: 'harness-native-workflow-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/workflow\/workflow-ptc\/src\/guest-source\.ts$/}, async ({path}) => ({
      contents: `export const WORKFLOW_GUEST_SOURCE = ${JSON.stringify(await guestSource(resolve(path, '../guest.ts'), guestPlugins))};`, loader: 'js',
    }));
    builder.onLoad({filter: /packages\/workflow\/workflow-ptc\/src\/host\.ts$/}, ({path}) => patch(path, [
      ['const PROGRAM = `const { runWorkflowGuest } = await import(${JSON.stringify(GUEST_URL)}); return await runWorkflowGuest(workflowHost);`', PROGRAM],
      ["program: this.runtime.programFormat === 'repl' ? `await (async () => {\\n${PROGRAM}\\n})()` : PROGRAM,", 'program: weftWorkflowProgram(this.init.body),'],
    ]));
    builder.onLoad({filter: /packages\/workflow\/workflow-ptc\/src\/index\.ts$/}, ({path}) => patch(path, [
      ["import * as vm from 'node:vm'", "import { parse as weftParse } from 'acorn'\nconst vm = { Script: class { constructor(source: string, _options?: unknown) { weftParse(source, { ecmaVersion: 'latest', sourceType: 'script' }) } } }"],
    ]));
  },
});
