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
const nativeDirectory={name:'local-host-native-directory',setup(builder){builder.onResolve({filter:/^\.\/native-directory\.js$/},()=>({path:resolve('deepseek-harness/packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx')}));}};
const client=await build({entryPoints:['packages/local-host-connector/client.tsx'],bundle:true,platform:'browser',format:'cjs',target:'es2022',minify:true,write:false,outdir:stage+'/client',loader:{'.css':'local-css'},plugins:[nativeDirectory],external:['react','react/jsx-runtime','@deepseek-ai/dsh-client-ui-primitives'],jsx:'automatic',tsconfig:'.generated/upstream.source.tsconfig.json'});
const code=client.outputFiles.find(file=>file.path.endsWith('.js'))?.text,css=client.outputFiles.find(file=>file.path.endsWith('.css'))?.text;
if(!code||!css)throw new Error('Local connector must include the native directory browser and its CSS');
writeFileSync(stage+'/package/client.js',`globalThis.__ModuleLoader__.load({id:${JSON.stringify(metadata.name)},factory(require){const module={exports:{}};const exports=module.exports;${code}\nconst apply=module.exports.apply;module.exports.apply=(ctx,...args)=>{ctx.effect(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);return()=>style.remove();},'weft.local-host: native directory browser styles');return apply(ctx,...args);};return module.exports;}});\n`);
writeFileSync(stage+'/package/LICENSE',readFileSync('LICENSE'));
execFileSync('tar',['-czf',target,'-C',stage,'package']);
