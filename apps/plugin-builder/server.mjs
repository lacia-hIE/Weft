import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, realpath, rm} from 'node:fs/promises';
import {resolve, join, dirname, posix} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {timingSafeEqual} from 'node:crypto';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';

const MAX_BODY = 18 * 1024 * 1024;
const safeName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const text = (bytes, start, length) => bytes.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonical(item))])) : value);
/** npm archives contain ordinary files and directories; special entries never reach disk. */
async function extract(archive, directory, budget) {
  const tar = gunzipSync(archive, {maxOutputLength: 32 * 1024 * 1024});
  budget.bytes += tar.length;
  if (budget.bytes > 64 * 1024 * 1024) throw new Error('Unpacked dependencies exceed 64 MiB');
  const seen = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (Number.parseInt(text(header, 148, 8).trim(), 8) !== checksum) throw new Error('Invalid tar checksum');
    const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry size');
    const type = text(header, 156, 1);
    const prefix = text(header, 345, 155);
    const name = (prefix ? prefix + '/' : '') + text(header, 0, 100);
    if (!['', '0', '5'].includes(type)) throw new Error('Archive links and special/PAX entries are unsupported');
    if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some(part => part === '..') || name.includes('\0')) throw new Error('Unsafe archive path');
    const relative = name.slice('package/'.length).replace(/\/$/, '');
    if (relative && (seen.has(relative) || relative.startsWith('/'))) throw new Error('Duplicate or absolute archive path');
    if (relative) {
      seen.add(relative); budget.files++;
      if (budget.files > 4096) throw new Error('Dependencies exceed 4096 files');
      const path = resolve(directory, relative);
      if (!path.startsWith(directory + '/')) throw new Error('Archive path escaped package');
      if (type === '5') await mkdir(path, {recursive: true});
      else {await mkdir(dirname(path), {recursive: true}); await writeFile(path, tar.subarray(offset + 512, offset + 512 + size), {flag: 'wx'});}
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}
function entryPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..') || value.includes('\0')) throw new Error('Invalid plugin entry path');
  return value;
}
const reactExports = ['Children', 'Component', 'Fragment', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense', 'cloneElement', 'createContext', 'createElement', 'createFactory', 'createRef', 'forwardRef', 'isValidElement', 'lazy', 'memo', 'startTransition', 'useCallback', 'useContext', 'useDebugValue', 'useDeferredValue', 'useEffect', 'useId', 'useImperativeHandle', 'useInsertionEffect', 'useLayoutEffect', 'useMemo', 'useReducer', 'useRef', 'useState', 'useSyncExternalStore', 'useTransition', 'version'];
export async function buildPackage(input) {
  if (!input || input.abi !== 'weft-plugin-v1' || !Array.isArray(input.packages) || input.packages.length > 32 || !safeName.test(input.name)) throw new Error('Invalid build request');
  const root = await mkdtemp(join(tmpdir(), 'weft-plugin-'));
  try {
    const modules = join(root, 'node_modules'); const budget = {bytes: 0, files: 0};
    const names = new Set();
    for (const item of input.packages) {
      if (!safeName.test(item.name) || names.has(item.name) || typeof item.bytes !== 'string') throw new Error('Invalid dependency');
      names.add(item.name);
      const directory = join(modules, item.name);
      await mkdir(directory, {recursive: true});
      await extract(Buffer.from(item.bytes, 'base64'), directory, budget);
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== item.name || manifest.version !== item.version) throw new Error('Archive identity differs from registry metadata');
      if (Object.keys(manifest.scripts ?? {}).some(key => ['install', 'preinstall', 'postinstall', 'prepare'].includes(key))) throw new Error('Installation scripts are unsupported');
      const lock = input.lock.find(row => row.name === item.name);
      if (!lock || lock.version !== item.version) throw new Error('Dependency lock differs from build input');
      const {createHash} = await import('node:crypto');
      if ('sha512-' + createHash('sha512').update(Buffer.from(item.bytes, 'base64')).digest('base64') !== lock.integrity) throw new Error('Archive integrity differs from lock');
    }
    const packageRoot = join(modules, input.name);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== input.version || canonical(manifest.weft?.plugin) !== canonical(input.declarationRaw)) throw new Error('Plugin declaration changed between registry and archive');
    const declaration = input.declaration;
    const result = {abi: input.abi, name: input.name, version: input.version, description: String(manifest.description ?? '').slice(0, 2000), permissions: declaration.permissions, lock: input.lock};
    for (const half of ['host', 'client']) {
      if (!declaration[half]) continue;
      const output = await build({
        entryPoints: [join(packageRoot, entryPath(declaration[half]))], absWorkingDir: root,
        bundle: true, write: false, format: 'iife', globalName: '__weft_package',
        outdir: join(root, 'output'), platform: 'browser', target: 'es2022', minify: true,
        conditions: [half === 'host' ? 'workerd' : 'browser', 'import'], logLevel: 'silent',
        plugins: [{name: 'reviewed-sdk', setup(builder) {
          builder.onLoad({filter: /.*/, namespace: 'file'}, async args => {
            const path = await realpath(args.path);
            if (!path.startsWith(root + '/')) return {errors: [{text: 'Plugin import escaped the build root'}]};
            return undefined;
          });
          builder.onResolve({filter: /^(?:node:|cloudflare:|https?:|data:)/}, args => ({errors: [{text: `Unsupported import: ${args.path}`}]}));
          builder.onResolve({filter: /^react$/}, () => half === 'client' ? {path: 'react', namespace: 'weft-sdk'} : {errors: [{text: 'React is only supported in Client modules'}]});
          builder.onLoad({filter: /.*/, namespace: 'weft-sdk'}, () => ({contents: 'export default __weft_sdk.React;' + reactExports.map(name => `export const ${name}=__weft_sdk.React.${name};`).join('')}));
        }}],
      });
      const js = output.outputFiles.find(file => file.path.endsWith('.js'))?.text;
      const css = output.outputFiles.find(file => file.path.endsWith('.css'))?.text;
      if (!js || Buffer.byteLength(js) > 1024 * 1024) throw new Error('Compiled plugin exceeds 1 MiB');
      if (css) throw new Error('CSS imports are not supported in v1; use a Client effect to own inline styles');
      result[half] = `export default async function(__weft_sdk){${js}\nif(typeof __weft_package.default!=="function")throw new Error("Plugin entry must export a default factory(sdk)");return await __weft_package.default(__weft_sdk);}`;
    }
    return result;
  } finally {await rm(root, {recursive: true, force: true});}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.BUILD_SECRET;
  delete process.env.BUILD_SECRET;
  if (!secret) throw new Error('Missing build authentication');
  let busy = false;
  createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {response.writeHead(403).end(); return;}
    if (request.method === 'GET' && request.url === '/health') {response.writeHead(200).end('ok'); return;}
    if (request.method !== 'POST' || request.url !== '/build') {response.writeHead(404).end(); return;}
    if (busy) {response.writeHead(409).end('Builder busy'); return;}
    busy = true;
    try {
      const blocks = []; let size = 0;
      for await (const block of request) {size += block.length; if (size > MAX_BODY) throw new Error('Build request exceeds 18 MiB'); blocks.push(block);}
      const output = await buildPackage(JSON.parse(Buffer.concat(blocks).toString('utf8')));
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(output));
    } catch (error) {response.writeHead(422, {'content-type': 'application/json'}).end(JSON.stringify({error: String(error.message).slice(0, 4000)}));}
    finally {busy = false;}
  }).listen(8080, '0.0.0.0');
}
