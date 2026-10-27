import Schema from '@deepseek-ai/schemastery';
import {header, json} from './shared.js';

/** Per-bot settings shared by the transports and the management page. */
export const botSettings = () => ({
  accountConfigured: Schema.boolean().description('Whether an account has been added through the settings page.'),
  displayName: Schema.string().default('').description('Local bot alias.'),
  workspace: Schema.string().default('/workspace').description('Workspace for new conversations.'),
  agentPreset: Schema.string().default('').description('Agent preset for new conversations; empty follows the shared IM default.'),
});

export const managementKey = () => Schema.string().role('secret').default('').description('Capability for the settings page connection checks.');

/** Private management routes use a header capability; public callback requests never grant it. */
export function registerManagement(ctx, channel, config, check) {
  const route = (path, method, run) => ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/${channel}/${path}`, handler: async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (!config.managementKey || header(request, 'authorization') !== `Bearer ${config.managementKey}`) {json(response, 403, {error: 'management key required'}); return;}
    if (request.method !== method) {json(response, 405, {error: `${method} required`}); return;}
    try {json(response, 200, await run());}
    // Provider errors can echo credentials; never send their text to the browser.
    catch {json(response, 502, {error: 'credential_check_failed'});}
  }}), `dsh-im ${channel} ${path}`);
  route('status', 'GET', async () => config.enabled ? (await check(), {state: 'ready', botId: config.appId, checkedAt: Date.now()}) : {state: 'disabled'});
  route('disconnect', 'POST', async () => {await ctx.im.clear(channel); return {state: 'idle'};});
}
