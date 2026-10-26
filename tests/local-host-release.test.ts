import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {parse} from 'yaml';
import {assertReleaseRun,assertReleaseJobs,inspectReleaseTarball,RELEASE_REPOSITORY,RELEASE_ENVIRONMENT,RELEASE_WORKFLOW} from '../scripts/local-host-release.mjs';
import {archiveFiles} from './helpers/package-fixture.ts';

test('npm releases accept only complete native Host validation from the exact repository and commit',()=>{
  const sha='a'.repeat(40),run={head_sha:sha,head_repository:{full_name:RELEASE_REPOSITORY},path:'.github/workflows/test.yml',head_branch:'ci',event:'push',status:'completed',conclusion:'success'};
  assertReleaseRun(run,sha);
  for(const changed of [{head_sha:'b'.repeat(40)},{head_repository:{full_name:'fork/Weft'}},{path:'.github/workflows/other.yml'},{head_branch:'main'},{event:'pull_request'},{status:'in_progress'},{conclusion:'failure'}])assert.throws(()=>assertReleaseRun({...run,...changed},sha));
  const engines='0.2.1-rc.2 || 0.2.1-rc.3',jobs=['build','Plugin package builder','Published local DSH (0.2.1-rc.2)','Published local DSH (0.2.1-rc.3)'].map(name=>({name,conclusion:'success'}));
  assertReleaseJobs(jobs,engines);
  assert.throws(()=>assertReleaseJobs(jobs.slice(0,-1),engines));
  assert.throws(()=>assertReleaseJobs([...jobs,{name:'Browser 1/2',conclusion:'skipped'}],engines));
  const workflow=parse(readFileSync('.github/workflows/'+RELEASE_WORKFLOW,'utf8')) as {jobs:Record<string,{if:string;environment?:string;permissions?:Record<string,string>}>};
  for(const job of Object.values(workflow.jobs)){assert.match(job.if,/github\.repository == 'lacia-hIE\/Weft'/);assert.match(job.if,/github\.ref == 'refs\/heads\/main'/);}
  assert.equal(workflow.jobs.publish!.environment,RELEASE_ENVIRONMENT);
  assert.equal(workflow.jobs.publish!.permissions!['id-token'],'write');
  assert.equal(workflow.jobs.prepare!.permissions!['id-token'],undefined);
});

test('release handoffs reject foreign metadata, missing runtime modules and unexpected archive content',()=>{
  const manifest=JSON.parse(readFileSync('packages/local-host-connector/package.json','utf8')) as {name:string;files:string[]};
  const files:Record<string,string>={};
  for(const name of new Set([...manifest.files,'package.json','LICENSE']))files[name]=name==='package.json'?JSON.stringify(manifest):name==='client.js'?`globalThis.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(){}});`:'fixture '+name;
  const sourceFile=(name:string)=>Buffer.from(files[name]!);
  const result=inspectReleaseTarball(archiveFiles(files),manifest,sourceFile);
  assert.equal(result.name,manifest.name);assert.equal(result.tag,'latest');assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>inspectReleaseTarball(archiveFiles({...files,'extra-secret.txt':'not publishable'}),manifest));
  assert.throws(()=>inspectReleaseTarball(archiveFiles({...files,'../escape':'unsafe'}),manifest));
  assert.throws(()=>inspectReleaseTarball(archiveFiles({...files,'package.json':JSON.stringify({...manifest,name:'@other/connector'})}),manifest));
  assert.throws(()=>inspectReleaseTarball(archiveFiles({...files,'index.mjs':'changed after testing'}),manifest,sourceFile));
  assert.throws(()=>inspectReleaseTarball(archiveFiles({...files,'client.js':'console.log("wrong module format")'}),manifest));
  const corrupt=gzipSync(Buffer.from('invalid archive'));assert.throws(()=>inspectReleaseTarball(corrupt,manifest));
});
