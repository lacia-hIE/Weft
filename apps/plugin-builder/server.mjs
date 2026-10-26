import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, realpath, rm} from 'node:fs/promises';
import {resolve, join, dirname, basename, relative, extname} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {timingSafeEqual, createHash} from 'node:crypto';
import {build} from 'esbuild';
import yaml from 'js-yaml';
import {applyEntryPatches} from './patch.mjs';
import {pathToFileURL} from 'node:url';

const MAX_BODY = 18 * 1024 * 1024;
const assetExtensions = ['png','jpg','jpeg','gif','webp','avif','svg','ico','woff','woff2','ttf','otf','wasm','txt'];
const assetPrefix = '__WEFT_ASSET__/';
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
  if (!input || !Array.isArray(input.packages) || input.packages.length > 32 || !safeName.test(input.name)) throw new Error('Invalid build request');
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
    if (manifest.version !== input.version || canonical(manifest.dsh?.bundle) !== canonical(input.declarationRaw)) throw new Error('Bundle declaration changed between registry and archive');
    const paths = typeof manifest.dsh?.bundle?.patch === 'string' ? [manifest.dsh.bundle.patch] : manifest.dsh?.bundle?.patch;
    if (!Array.isArray(paths) || !paths.length || paths.length > 16) throw new Error('Package must declare dsh.bundle.patch');
    const patch = [];
    let nodes=0;const seen=new Set();
    const safeJson = (value,depth=0) => {
      if (++nodes>8192 || depth>32) throw new Error('Bundle patch nesting exceeds limits');
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) throw new Error('YAML aliases and cycles are unsupported');seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (['__jsExpr', '__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Configuration expressions and unsafe keys are unsupported');
        safeJson(child,depth+1);
      }
    };
    for (const path of paths) {
      const source = await readFile(join(packageRoot, entryPath(path)), 'utf8');
      if (Buffer.byteLength(source) > 65536) throw new Error('Bundle patch exceeds 64 KiB');
      const layer = yaml.load(source, {schema: yaml.JSON_SCHEMA, maxAliasCount: 0});
      if (!Array.isArray(layer)) throw new Error('Bundle patch must be an entry patch list');
      safeJson(layer); patch.push(...layer);
    }
    if (patch.length > 128 || Buffer.byteLength(JSON.stringify(patch)) > 262144) throw new Error('Bundle patch exceeds limits');
    for (const operation of patch) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Invalid bundle patch operation');
      if (Object.keys(operation).some(key => !['id','insert','name','config','group','disabled','inject','intercept','isolate'].includes(key))) throw new Error('Unsupported bundle patch operation');
    }
    const rows = applyEntryPatches([], patch, (message, ...args) => {throw new Error('Bundle patch targets an unavailable entry: '+message+' '+args.join(' '));});
    const leaves = [], ids = new Set();
    const walk = (rows, off = false, depth = 0) => {
      if (!Array.isArray(rows) || depth > 8) throw new Error('Invalid bundle group');
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id) || ids.size >= 64) throw new Error('Invalid, duplicate or excessive bundle entry ids');
        ids.add(row.id);
        if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new Error('Bundle disabled must be a literal boolean');
        const disabled = off || row.disabled === true;
        if (row.group) {if (row.name !== 'group' && row.name !== 'cordis:group' && row.name !== '@deepseek-ai/cordis-plugin-group') throw new Error('Unsupported group module'); walk(row.config, disabled, depth+1);}
        else if (!disabled) {
          if (typeof row.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._/-]+)?$/.test(row.name) || row.name.split('/').includes('..')) throw new Error('Bundle entries must name installed package exports');
          const parts = row.name.split('/'), packageName = parts[0].startsWith('@') ? parts.slice(0,2).join('/') : parts[0];
          if (!names.has(packageName)) throw new Error('Bundle module is outside its locked dependencies: '+row.name);
          leaves.push({...row, packageName});
        }
      }
    };
    walk(rows);
    const result = {name: input.name, version: input.version, description: String(manifest.description ?? '').slice(0,2000), patch, rows, lock: input.lock,
      permissions: {files: leaves.length ? 'write' : 'none', tools: leaves.length > 0, timer: leaves.length > 0, client: false}};
    const cordisExports = ['Context','Service','Inject','Logger'];
    const compile = async (half, selected) => {
      if (!selected.length) return;
      const imports = selected.map((row,i) => `import * as m${i} from ${JSON.stringify(half === 'client' ? row.packageName+'/client' : row.name)};`).join('\n');
      const table = selected.map((row,i) => `${JSON.stringify(row.name)}:m${i}`).join(',');
      const assets = {};
      const cssNamespace='weft_'+createHash('sha256').update(input.name+'\0'+input.version).digest('hex').slice(0,12);
      const collectAssets = output => {
        for (const file of output.outputFiles) {
          if (file.path.endsWith('.js') || file.path.endsWith('.css')) continue;
          const name = relative(join(root,'output'), file.path);
          if (!/^assets\/[A-Z0-9]+\.[a-z0-9]+$/i.test(name) || !assetExtensions.includes(extname(name).slice(1))) throw new Error('Unsupported Client asset');
          if (file.contents.length > 1048576) throw new Error('Client asset exceeds 1 MiB');
          assets[name] = Buffer.from(file.contents).toString('base64');
        }
        if (Object.keys(assets).length > 128 || Object.values(assets).reduce((size, value) => size + Buffer.from(value,'base64').length, 0) > 4194304) throw new Error('Client assets exceed 128 files or 4 MiB');
      };
      const options = {absWorkingDir: root,
        bundle: true, write: false, format: 'iife', globalName: '__bundle', outdir: join(root,'output'), platform: 'browser', target: 'es2022',
        minifyWhitespace:true, minifySyntax:true, minifyIdentifiers:half==='host',
        publicPath: assetPrefix, assetNames: 'assets/[hash]', loader: Object.fromEntries(assetExtensions.map(ext=>['.'+ext,'file'])),
        conditions: [half === 'host' ? 'workerd' : 'browser','import'], logLevel: 'silent', plugins: [{name: 'native-platform', setup(builder) {
          builder.onResolve({filter: /\.module\.css$/}, async args => {
            if (args.pluginData?.scopedCss) return;
            if (half !== 'client') return {errors:[{text:'CSS and static assets require a Client entry'}]};
            const resolved=await builder.resolve(args.path,{resolveDir:args.resolveDir,kind:args.kind,pluginData:{scopedCss:true}});
            if (resolved.errors.length) return resolved;
            const path=await realpath(resolved.path);
            if (!path.startsWith(root+'/')) return {errors:[{text:'Plugin import escaped build root'}]};
            return {path:join(dirname(path),cssNamespace+'_'+basename(path)),namespace:'weft-css-module',pluginData:{source:path}};
          });
          builder.onLoad({filter: /.*/,namespace:'weft-css-module'},async args=>({contents:await readFile(args.pluginData.source,'utf8'),loader:'local-css',resolveDir:dirname(args.pluginData.source)}));
          builder.onResolve({filter: /\?(?:inline|raw|url)$/}, async args => {
            const suffix = args.path.slice(args.path.lastIndexOf('?'));
            const resolved = await builder.resolve(args.path.slice(0,-suffix.length), {resolveDir: args.resolveDir, kind: args.kind, pluginData:{scopedCss:true}});
            return {...resolved, suffix};
          });
          builder.onLoad({filter: /.*/, namespace: 'file'}, async args => {
            const path=await realpath(args.path);
            if (!path.startsWith(root+'/')) return {errors:[{text:'Plugin import escaped build root'}]};
            const ext = extname(path).slice(1), css = ext === 'css';
            if (half === 'host' && (css || assetExtensions.includes(ext) || args.suffix)) return {errors:[{text:'CSS and static assets require a Client entry'}]};
            if (args.suffix === '?raw') return {contents: await readFile(path,'utf8'), loader:'text'};
            if (args.suffix === '?inline') {
              if (!css) return {errors:[{text:'Only CSS supports ?inline; use ?raw for text'}]};
              const output = await build({...options, entryPoints:[path]});
              collectAssets(output);
              const sheet = output.outputFiles.find(file=>file.path.endsWith('.css'))?.text;
              if (sheet === undefined || Buffer.byteLength(sheet)>1048576) throw new Error('Inline CSS exceeds 1 MiB');
              return {contents:`export default __runtime.css(${JSON.stringify(sheet)});`,loader:'js'};
            }
            if (args.suffix === '?url' && !assetExtensions.includes(ext)) return {errors:[{text:'Unsupported URL asset type'}]};
            if (css) return {contents:await readFile(path,'utf8'),loader:path.endsWith('.module.css')?'local-css':'css',resolveDir:dirname(path)};
          });
          const hostModules={'node:crypto':'crypto','node:buffer':'buffer','@deepseek-ai/dsh-webhook':'webhook','@deepseek-ai/dsh-credentials':'credentials','@deepseek-ai/schemastery':'schema','@deepseek-ai/dsh-util-values':'values','@deepseek-ai/dsh-session':'session'};
          builder.onResolve({filter:/^(?:node:(?:crypto|buffer)|@deepseek-ai\/(?:dsh-(?:webhook|credentials|util-values|session)|schemastery))$/},args=>half==='host'?{path:args.path,namespace:'worker-host-module'}:undefined);
          builder.onLoad({filter:/.*/,namespace:'worker-host-module'},args=>({contents:`module.exports=__runtime.${hostModules[args.path]};`,loader:'js'}));
          builder.onResolve({filter: /^(?:node:|cloudflare:|https?:|data:)/}, args=>({errors:[{text:'Unsupported import: '+args.path}]}));
          builder.onResolve({filter: /^(?:react(?:\/jsx(?:-dev)?-runtime)?|@deepseek-ai\/cordis|@deepseek-ai\/dsh-tools|@deepseek-ai\/dsh-client-ui-primitives)$/}, args=>({path: args.path, namespace:'native-platform'}));
          builder.onLoad({filter: /.*/, namespace:'native-platform'}, args => {
            if (args.path==='react') return half==='client' ? {contents:'export default __runtime.React;'+reactExports.map(name=>`export const ${name}=__runtime.React.${name};`).join('')} : {errors:[{text:'React requires a Client entry'}]};
            if (args.path.startsWith('react/')) return half==='client' ? {contents:'export const Fragment=__runtime.React.Fragment;export function jsx(type,{children,...props},key){return __runtime.React.createElement(type,{...props,key},children)};export const jsxs=jsx;export const jsxDEV=jsx;'} : {errors:[{text:'React requires a Client entry'}]};
            if (args.path==='@deepseek-ai/dsh-client-ui-primitives') return half==='client' ? {contents:'module.exports=__runtime.ui;',loader:'js'} : {errors:[{text:'UI primitives require a Client entry'}]};
            const exports=args.path==='@deepseek-ai/cordis' ? cordisExports : ['defineTool'];
            const namespace=args.path==='@deepseek-ai/cordis' ? 'cordis' : 'tools';
            return {contents:exports.map(name=>`export const ${name}=__runtime.${namespace}.${name};`).join('')};
          });
        }}]};
      const output = await build({...options, stdin: {contents: imports+`\nexport const modules={${table}};`, resolveDir: root}});
      collectAssets(output);
      const js=output.outputFiles.find(file=>file.path.endsWith('.js'))?.text.replace(/"__WEFT_ASSET__\/(assets\/[A-Z0-9]+\.[a-z0-9]+)"/gi, (_,path)=>`__runtime.asset(${JSON.stringify(path)})`);
      if (!js || Buffer.byteLength(js)>1048576) throw new Error('Compiled bundle exceeds 1 MiB');
      const css=output.outputFiles.find(file=>file.path.endsWith('.css'))?.text;
      if (css !== undefined) {
        if (half !== 'client' || Buffer.byteLength(css)>1048576) throw new Error('Client stylesheet exceeds 1 MiB');
        result.css=css.replaceAll(assetPrefix,'./');
      }
      if (Object.keys(assets).length) result.assets=assets;
      const selection = new Set(selected.map(row=>row.name));
      const selectRows = list => list.filter(row=>row.group || selection.has(row.name)).map(row=>row.group ? {...row, config:selectRows(row.config)} : row);
      result[half]=`export default async function(__runtime){${js}\nreturn __runtime.compose(${JSON.stringify(half==='client' ? selected.map((row,i)=>({id:'client-'+i,name:row.name,config:{}})) : selectRows(rows))},__bundle.modules);}`;
      if (half === 'client') result.client += `\nexport const stylesheet=${Boolean(css)};`;
    };
    const clients=[];
    for (const row of leaves) {
      const pkg=JSON.parse(await readFile(join(modules,row.packageName,'package.json'),'utf8'));
      if (pkg.dsh?.client) {
        if (pkg.dsh.client.platform!=='web') throw new Error('Only Web Client modules are supported');
        if (!clients.some(client=>client.packageName===row.packageName)) clients.push({...row,name:row.packageName});
      }
    }
    await compile('host', leaves);
    await compile('client', clients);
    result.permissions.client=Boolean(result.client);
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
