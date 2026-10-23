import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {loadDeploymentConfig, requireDeploymentConfig} from '../scripts/deployment-config.ts';

test('deployment configuration is portable, private, validated and required before publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-deployment-'));
  const filename = join(directory, 'deployment.json');
  try {
    const config = loadDeploymentConfig({env: {}, filename});
    assert.equal(config.workerName, 'weft');
    assert.equal(config.domain, undefined);
    assert.throws(() => requireDeploymentConfig(config), /incomplete/);
    writeFileSync(filename, JSON.stringify({workerName: 'local-weft'}));
    assert.equal(loadDeploymentConfig({env: {}, filename}).workerName, 'local-weft');
    assert.equal(loadDeploymentConfig({env: {WEFT_DEPLOY_CONFIG: '{"workerName":"cloud-weft"}'}, filename}).workerName, 'cloud-weft');
    for (const value of ['{', '{"accessAudience":"PRIVATE_INVALID_VALUE"}', '{"unexpected":"PRIVATE_INVALID_VALUE"}', '{"workerName":"same","uiWorkerName":"same"}']) {
      assert.throws(() => loadDeploymentConfig({env: {WEFT_DEPLOY_CONFIG: value}, filename}), error => error instanceof Error && !error.message.includes('PRIVATE_INVALID_VALUE'));
    }
    const workspace = JSON.parse(readFileSync('apps/workspace-container/image.json', 'utf8')).reference as string;
    const builder = JSON.parse(readFileSync('apps/plugin-builder/image.json', 'utf8')).reference as string;
    assert.match(workspace, /^weft-workspace-shell:[a-f0-9]{12}$/);
    assert.match(builder, /^weft-plugin-builder:[a-f0-9]{12}$/);
    const cloud = loadDeploymentConfig({env: {WEFT_DEPLOY_CONFIG: JSON.stringify({domain:'weft.example.com', accessAudience:'a'.repeat(64), accessTeamDomain:'example.cloudflareaccess.com',databaseId:'00000000-0000-4000-8000-000000000001', workspaceImage:'registry.cloudflare.com/'+'a'.repeat(32)+'/'+workspace, pluginBuilderImage:'registry.cloudflare.com/'+'a'.repeat(32)+'/'+builder})}, filename});
    requireDeploymentConfig(cloud);
    assert.throws(() => requireDeploymentConfig({...cloud, pluginBuilderImage: cloud.pluginBuilderImage!.replace(/:[a-f0-9]{12}$/, ':000000000000')}), /reviewed image tag/);
  } finally {rmSync(directory, {recursive:true, force:true});}
});

test('a fresh development checkout starts the production Worker with local identity, D1 migrations and Worker Loader', {timeout:90000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-dev-'));
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {env:{...process.env, WEFT_DEPLOY_CONFIG:'{}', WEFT_DEV_PORT:'0', WEFT_DEV_STATE_DIR:directory}, stdio:['ignore','pipe','pipe']});
  let output = '';
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Development startup timed out: '+output.slice(-2000))), 60000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); reject(new Error(`Development process exited ${code}: ${output.slice(-2000)}`));});
    child.stdout.on('data', chunk => {output += chunk; const address = /Local workerd ready: (https?:\/\/\S+)/.exec(output)?.[1]; if (address) {clearTimeout(timer); resolve(address);}});
    child.stderr.on('data', chunk => {output += chunk;});
  });
  try {
    const address = await ready;
    assert.equal((await fetch(new URL('/health',address))).status,200);
    const response = await fetch(new URL('/v1/me',address));
    assert.equal(response.status,200);
    const me = await response.json() as {tenantId:string};
    assert.ok(me.tenantId);
    const environments = await fetch(new URL(`/v1/tenants/${me.tenantId}/environments`, address));
    assert.equal(environments.status,200);
    const method = 'settings/describe';
    const settings = await fetch(new URL(`/v1/tenants/${me.tenantId}/environments/default/native/api/${method}`, address), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'dev-smoke',method,payload:{args:{}}})});
    assert.equal(settings.status,200);
    assert.equal((await settings.json() as {result:{ok:boolean}}).result.ok,true);
  } finally {
    if (child.exitCode === null) {const exited = new Promise(resolve => child.once('exit', resolve));child.kill('SIGTERM');await exited;}
    rmSync(directory,{recursive:true,force:true});
  }
});
