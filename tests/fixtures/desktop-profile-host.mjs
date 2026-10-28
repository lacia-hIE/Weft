// CI-only: boot the published DSH the way DeepSeek Harness Desktop's Host child does
// (apps/desktop-host and apps/desktop/src/project-manager.ts at the pinned release),
// without Electron. The fixture copies this file into the npm install so the bare
// imports below resolve against that exact release.
// Usage: node desktop-profile-host.mjs <runtimeDir> <profileDir>
import {existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {initProfile, loadLayeredEnv, loadProfileDirectory, PROFILE_TEMPLATES, reportSkippedBundles} from '@deepseek-ai/dsh-app-boot';
import {runProfile} from '@deepseek-ai/dsh/profile-boot';

const [runtimeDir, profileDir] = process.argv.slice(2);
// Desktop creates its plugin profile from the Web template on first launch.
if (!existsSync(join(profileDir, 'package.json'))) {mkdirSync(profileDir, {recursive: true}); initProfile(profileDir, PROFILE_TEMPLATES.web.bundles);}
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
reportSkippedBundles('dsh', profile);
const application = runProfile({
  environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: {profile, installAnchor}, patchFiles: [],
  args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
});
const {ctx} = await application;
// Electron receives this URL over IPC; the fixture reads it from stdout instead.
console.log(`WEFT_DESKTOP_READY ${ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)}`);
let stopping;
const stop = () => stopping ??= application.then(running => running.shutdown.shutdown(0)).finally(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
