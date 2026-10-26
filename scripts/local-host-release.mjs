import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const RELEASE_REPOSITORY='lacia-hIE/Weft';
export const RELEASE_ENVIRONMENT='npm-production';
export const RELEASE_WORKFLOW='publish-local-host.yml';
const root=resolve(import.meta.dirname,'..');
const metadata=()=>JSON.parse(readFileSync(resolve(root,'packages/local-host-connector/package.json'),'utf8'));
export function assertReleaseRun(run,sha) {
  assert.match(sha,/^[a-f0-9]{40}$/);
  assert.equal(run.head_sha,sha,'CI must test the exact main commit being published');
  assert.equal(run.head_repository?.full_name,RELEASE_REPOSITORY,'CI must belong to the fixed repository');
  assert.equal(run.path,'.github/workflows/test.yml');
  assert.equal(run.head_branch,'ci');assert.equal(run.event,'push');
  assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
}
export function assertReleaseJobs(jobs,engines) {
  assert.ok(jobs.length>0 && jobs.every(job=>job.conclusion==='success'),'Every CI job must pass without skipped jobs');
  for(const name of ['build','Plugin package builder',...engines.split(' || ').map(version=>`Published local DSH (${version})`)]) {
    assert.ok(jobs.some(job=>job.name===name),'CI is missing required validation: '+name);
  }
}
/** Validate the final native archive without executing any of its code or writing archive paths. */
export function inspectReleaseTarball(bytes,expected,sourceFile) {
  const tar=gunzipSync(bytes,{maxOutputLength:8*1024*1024}),files=new Map();
  const text=(header,start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
  for(let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
    let checksum=0;for(let index=0;index<512;index++)checksum+=index>=148&&index<156?32:header[index];
    assert.equal(Number.parseInt(text(header,148,8).trim(),8),checksum,'Invalid tar checksum');
    const path=(text(header,345,155)?text(header,345,155)+'/':'')+text(header,0,100),type=text(header,156,1);
    const size=Number.parseInt(text(header,124,12).trim()||'0',8);
    assert.ok(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'Invalid tar size');
    assert.ok(path.startsWith('package/')&&!path.includes('\\')&&!path.split('/').includes('..'),'Unsafe archive path');
    assert.ok(['','0','5'].includes(type),'Archive links and special files are refused');
    if(type!=='5') {
      const name=path.slice(8);assert.ok(!files.has(name),'Duplicate archive entry');
      files.set(name,tar.subarray(offset+512,offset+512+size));
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  const manifest=JSON.parse(files.get('package.json')?.toString()??'null');
  assert.deepEqual(manifest,expected,'Archive metadata must match the reviewed source');
  assert.equal(manifest.repository.url,'git+https://github.com/'+RELEASE_REPOSITORY+'.git');
  assert.equal(manifest.publishConfig.registry,'https://registry.npmjs.org/');assert.equal(manifest.publishConfig.access,'public');
  assert.ok(manifest.dsh?.bundle?.patch);assert.equal(manifest.dsh.client.platform,'web');
  const allowed=new Set([...manifest.files,'package.json','LICENSE']);
  assert.equal(files.size,allowed.size,'Archive must contain only the declared runtime files');
  for(const name of allowed) {
    const value=files.get(name);assert.ok(value?.length,'Missing runtime file: '+name);
    if(name==='client.js') {
      assert.ok(value.toString().startsWith('globalThis.__ModuleLoader__.load({id:'+JSON.stringify(manifest.name)),'Client must use the native module loader identity');
    } else if(sourceFile) assert.deepEqual(value,sourceFile(name),'Archive source differs: '+name);
  }
  return {name:manifest.name,version:manifest.version,sha256:createHash('sha256').update(bytes).digest('hex'),tag:manifest.version.includes('-')?'next':'latest'};
}
async function api(path) {
  const token=process.env.GH_TOKEN;
  assert.ok(token,'A read-only Actions token is required');
  const response=await fetch('https://api.github.com/repos/'+RELEASE_REPOSITORY+'/'+path,{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json'},redirect:'error'});
  assert.ok(response.ok,'GitHub request failed: HTTP '+response.status);return response.json();
}
async function main() {
  const command=process.argv[2],manifest=metadata();
  const output=value=>{if(process.env.GITHUB_OUTPUT)for(const [key,item]of Object.entries(value))appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${item}\n`);};
  if(command==='ci') {
    assert.equal(process.env.GITHUB_REPOSITORY,RELEASE_REPOSITORY);assert.equal(process.env.GITHUB_REF,'refs/heads/main');
    const sha=process.env.GITHUB_SHA;
    let run;
    if(process.env.RELEASE_CI_RUN) {assert.match(process.env.RELEASE_CI_RUN,/^\d+$/);run=await api('actions/runs/'+process.env.RELEASE_CI_RUN);}
    else {
      const result=await api(`actions/workflows/test.yml/runs?head_sha=${sha}&branch=ci&event=push&status=success&per_page=20`);
      run=result.workflow_runs.find(item=>item.head_sha===sha);
    }
    assert.ok(run,'Run the Test workflow on ci for this exact main commit before publishing');assertReleaseRun(run,sha);
    const jobs=[];for(let page=1;;page++){const batch=await api(`actions/runs/${run.id}/jobs?per_page=100&page=${page}`);jobs.push(...batch.jobs);if(batch.jobs.length<100)break;}
    assertReleaseJobs(jobs,manifest.engines.dsh);output({run_id:run.id});console.log('Verified successful CI for '+sha);return;
  }
  assert.equal(command,'prepare');
  const requested=process.env.RELEASE_VERSION;assert.equal(requested,manifest.version,'Requested version differs from package.json');
  assert.match(manifest.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const entry=`dist/public/downloads/weft-dsh-local-host-${manifest.version}.tgz`;
  const bytes=execFileSync('tar',['-xOzf',resolve(process.argv[3]),entry],{maxBuffer:8*1024*1024});
  const sourceFile=name=>readFileSync(resolve(root,name==='LICENSE'?'LICENSE':'packages/local-host-connector/'+name));
  const result={...inspectReleaseTarball(bytes,manifest,sourceFile),sourceSha:process.env.GITHUB_SHA,ciRunId:process.env.RELEASE_CI_RUN};
  const directory=resolve(process.argv[4]);mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,'package.tgz'),bytes);writeFileSync(resolve(directory,'release.json'),JSON.stringify(result,null,2)+'\n');
  output({tag:result.tag});console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
