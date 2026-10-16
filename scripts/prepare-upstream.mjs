import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const output = resolve(root, '.generated');
const sourcePath = path => {
  const result = relative(output, path);
  return result.startsWith('.') ? result : './' + result;
};
mkdirSync(output, { recursive: true });
const configuredCheckout = resolve(root, lock.directory);
let checkout = configuredCheckout;
if (existsSync(checkout)) {
  const existing = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (existing !== lock.commit || dirty) {
    checkout = resolve(output, 'upstream', lock.commit);
    console.log('Preserving the existing Harness checkout; using an isolated pinned source copy.');
  }
}
if (!existsSync(checkout)) {
  mkdirSync(resolve(checkout, '..'), { recursive: true });
  execFileSync('git', ['clone', '--no-checkout', lock.repository, checkout], { stdio: 'inherit' });
  execFileSync('git', ['-C', checkout, 'checkout', '--detach', lock.commit], { stdio: 'inherit' });
}
const actual = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actual !== lock.commit) throw new Error(`Upstream commit mismatch: expected ${lock.commit}, got ${actual}. Checkout was not modified.`);
const changes = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
if (changes.trim()) throw new Error('Upstream has tracked changes. Resolve them before validating the pinned source.');
const config = ts.readConfigFile(resolve(checkout, 'tsconfig.base.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const paths = Object.fromEntries(Object.entries(config.config.compilerOptions.paths).map(([name, targets]) => [
  name, targets.map(target => sourcePath(resolve(checkout, target))),
]));
paths['@weft/upstream/*'] = [sourcePath(checkout) + '/*'];
writeFileSync(resolve(output, 'upstream-source.json'), JSON.stringify({ directory: checkout, commit: actual }) + '\n');
writeFileSync(resolve(output, 'upstream.source.tsconfig.json'), JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n');
// Vendored libraries use their own relaxed compiler settings upstream. Emit their
// declarations separately so Weft and Harness packages retain strict checking.
const vendorNames = ['cordis', 'cosmokit', 'schemastery'];
const declarationOnlyPackages = {
  '@deepseek-ai/dsh-repeat-tool-reminder': 'packages/guard/repeat-tool-reminder/src/index.ts',
  // Inspection references the gateway's types; its Node HTTP implementation is
  // never bundled into Weft. Consume its own declarations at this boundary.
  '@deepseek-ai/dsh-api-gateway': 'packages/api/gateway/src/index.ts',
};
// This pinned upstream module has a broad-union MessageSource spread which its
// standalone source check rejects. Consume its declarations without changing it;
// real workerd tests verify the plugin's runtime behavior and event vocabulary.
const vendorEntries = [...vendorNames.map(name => resolve(checkout, 'vendor', name, 'src/index.ts')), ...Object.values(declarationOnlyPackages).map(path => resolve(checkout, path))];
const absolutePaths = Object.fromEntries(Object.entries(config.config.compilerOptions.paths).map(([name, targets]) => [
  name, targets.map(target => resolve(checkout, target)),
]));
const declarationProgram = ts.createProgram(vendorEntries, {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true,
  emitDeclarationOnly: true,
  noCheck: true,
  rootDir: checkout,
  outDir: resolve(output, 'types'),
  paths: absolutePaths,
});
const emitted = declarationProgram.emit();
if (emitted.emitSkipped) throw new Error('Unable to emit pinned vendor declarations');
const typePaths = { ...paths };
for (const name of vendorNames) typePaths[`@deepseek-ai/${name}`] = [`./types/vendor/${name}/src/index.d.ts`];
for (const [name, path] of Object.entries(declarationOnlyPackages)) typePaths[name] = [`./types/${path.replace(/\.ts$/, '.d.ts')}`];
writeFileSync(resolve(output, 'upstream.tsconfig.json'), JSON.stringify({ compilerOptions: { paths: typePaths } }, null, 2) + '\n');
console.log(`Pinned Harness ${actual.slice(0, 12)}; generated source aliases.`);
