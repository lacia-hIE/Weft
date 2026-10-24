import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
// Run only as part of the CI build. Ship a native dsh.bundle.patch package.
const stage=resolve('.generated/local-host-package'),target=resolve('dist/public/downloads/weft-dsh-local-host-0.1.0.tgz');
mkdirSync(stage+'/package',{recursive:true});mkdirSync(resolve('dist/public/downloads'),{recursive:true});
for(const name of ['package.json','index.mjs','transport.mjs','dsh.bundle.patch.yml','README.md'])writeFileSync(stage+'/package/'+name,readFileSync('packages/local-host-connector/'+name));
writeFileSync(stage+'/package/LICENSE',readFileSync('LICENSE'));
execFileSync('tar',['-czf',target,'-C',stage,'package']);
