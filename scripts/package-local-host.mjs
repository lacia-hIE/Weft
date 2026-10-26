import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {LOCAL_HOST_BUNDLE} from '../packages/local-host-connector/compatibility.mjs';
import metadata from '../packages/local-host-connector/package.json' with {type:'json'};
import {build} from 'esbuild';
// Run only as part of the CI build. Ship a native dsh.bundle.patch package.
const stage=resolve('.generated/local-host-package'),target=resolve('dist/public/downloads',LOCAL_HOST_BUNDLE);
mkdirSync(stage+'/package',{recursive:true});mkdirSync(resolve('dist/public/downloads'),{recursive:true});
for(const name of ['package.json',...metadata.files.filter(name=>name!=='client.js')]){
  const file=stage+'/package/'+name;mkdirSync(dirname(file),{recursive:true});writeFileSync(file,readFileSync('packages/local-host-connector/'+name));
}
const client=await build({entryPoints:['packages/local-host-connector/client.tsx'],bundle:true,platform:'browser',format:'cjs',target:'es2022',minify:true,write:false,external:['react','@deepseek-ai/dsh-client-ui-primitives'],jsx:'transform',tsconfig:'.generated/upstream.source.tsconfig.json'});
writeFileSync(stage+'/package/client.js',`globalThis.__ModuleLoader__.load({id:${JSON.stringify(metadata.name)},factory(require){const module={exports:{}};const exports=module.exports;${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
writeFileSync(stage+'/package/LICENSE',readFileSync('LICENSE'));
execFileSync('tar',['-czf',target,'-C',stage,'package']);
