import {resolve} from 'node:path';

/**
 * Computer's worker-shell backend ships just-bash to its Dynamic Worker as
 * prebuilt module text. The same module also imports just-bash for
 * `ShellWorker`, which runs only inside that Dynamic Worker; the parent
 * isolate must not carry or execute it, so the parent build resolves the
 * import to a stub that fails if ever reached.
 */
export const nativeShellPlatform = {
  name: 'harness-native-shell-platform',
  setup(builder) {
    // capnweb's workerd export makes its RpcTarget the platform's, so Computer's
    // Workspace stub crosses Durable Object RPC; the browser build cannot.
    builder.onResolve({filter: /^capnweb$/}, () => ({path: resolve('node_modules/capnweb/dist/index-workers.js')}));
    builder.onResolve({filter: /^just-bash$/}, ({importer}) => {
      if (!/@cloudflare\/computer\/dist\/backends\/worker-shell\/index\.js$/.test(importer)) throw new Error(`Unexpected just-bash importer ${importer}; review the shell isolation`);
      return {path: 'just-bash', namespace: 'weft-shell-stub'};
    });
    // workerd cannot createRequire at runtime; the terminal emulator modules are bundled instead.
    builder.onLoad({filter: /packages\/api\/terminal-controller\/src\/terminal\.ts$/}, async ({path}) => {
      let source = (await import('node:fs')).readFileSync(path, 'utf8');
      for (const [before, after] of [
        ["const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)", "import * as XtermHeadless from '@xterm/headless'\nconst requireHeadless = () => XtermHeadless"],
        ["const requireSerialize = createLazyRequire<typeof import('@xterm/addon-serialize')>('@xterm/addon-serialize', import.meta.url)", "import * as XtermSerialize from '@xterm/addon-serialize'\nconst requireSerialize = () => XtermSerialize"],
      ]) {
        if (!source.includes(before)) throw new Error('Upstream terminal emulator loading changed; review the workerd bundling');
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onLoad({filter: /packages\/terminal\/terminal-bash\/src\/session\.ts$/}, async ({path}) => {
      const source = (await import('node:fs')).readFileSync(path, 'utf8');
      const before = "const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)";
      if (!source.includes(before)) throw new Error('Upstream terminal-bash emulator loading changed; review the workerd bundling');
      return {contents: source.replace(before, "import * as XtermHeadless from '@xterm/headless'\nconst requireHeadless = () => XtermHeadless"), loader: 'ts', resolveDir: resolve(path, '..')};
    });
    builder.onLoad({filter: /.*/, namespace: 'weft-shell-stub'}, () => ({
      contents: "const unavailable = () => { throw new Error('just-bash runs only inside the shell Dynamic Worker'); };\nexport const Bash = class { constructor() { unavailable(); } };\nexport const defineCommand = unavailable;\n",
      loader: 'js',
    }));
  },
};
