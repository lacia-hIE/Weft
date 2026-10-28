import Schema from '@deepseek-ai/schemastery';
import {header, json} from './shared.js';
import {evaluateAccessPolicy} from './reference/access-policy.mjs';

const userPolicy = () => Schema.object({id: Schema.string(), canExecuteCommands: Schema.boolean()});
const scenePolicy = () => Schema.object({
  mode: Schema.union(['open', 'allowlist']),
  open: Schema.object({defaultCanExecuteCommands: Schema.boolean(), commandPermissionOverrides: Schema.array(userPolicy())}),
  allowlist: Schema.object({users: Schema.array(userPolicy())}),
});
const contextScene = () => Schema.object({
  enabled: Schema.boolean().default(false),
  fields: Schema.array(Schema.union(['channel', 'conversationType', 'senderId', 'senderName', 'conversationTitle', 'chatId', 'threadId', 'botId', 'sentAt'])).default(['senderId']),
  guidance: Schema.string().max(8000).default(''),
});

/** Per-bot settings shared by the transports and the management page. */
export const botSettings = () => ({
  accountConfigured: Schema.boolean().description('Whether an account has been added through the settings page.'),
  displayName: Schema.string().default('').description('Local bot alias.'),
  workspace: Schema.string().default('/workspace').description('Workspace for new conversations.'),
  agentPreset: Schema.string().default('').description('Agent preset for new conversations; empty follows the shared IM default.'),
  busyMessageMode: Schema.union(['queue', 'steer']).default('queue').description('Queue new text or add it to the current task.'),
  sessionSync: Schema.union(['scheduled', 'all', 'off']).default('scheduled').description('Send turns the chat did not start: schedule results, or also Web turns in private chats.'),
  modelSelection: Schema.union([Schema.const(null), Schema.object({provider: Schema.string().min(1), model: Schema.string().min(1), reasoningEffort: Schema.string()})]).default(null).description('Model and optional reasoning effort for new Sessions; null follows the Host default.'),
  // Null preserves the legacy allowlist until the administrator explicitly saves a policy.
  accessPolicy: Schema.union([Schema.const(null), Schema.object({direct: scenePolicy(), group: scenePolicy()})]).default(null),
  contextEnhancement: Schema.object({direct: contextScene(), group: contextScene()}),
});

/** Channel-independent behavior; the QR owner keeps administrative command access. */
export function channelSettings(config, owner, botId) {
  return {
    workspace: config.workspace, agentPreset: config.agentPreset,
    busyMessageMode: config.busyMessageMode, sessionSync: config.sessionSync, contextEnhancement: config.contextEnhancement, modelSelection: config.modelSelection,
    botId,
    access(message, isCommand = false) {
      if (message.sender && message.sender === owner()) return {allowed: true};
      if (config.accessPolicy == null) return {allowed: (config.allowedSenders ?? []).includes(message.sender)};
      return evaluateAccessPolicy(config.accessPolicy, {conversationType: message.group ? 'group' : 'direct', senderIds: message.sender, isCommand});
    },
  };
}

/** Catalog metadata contains no credentials and is protected by the channel's management capability. */
export function registerModelCatalog(ctx, channel, config) {
  ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/${channel}/catalog`, handler: async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    const key = channel === 'weixin' ? config.loginKey : config.managementKey;
    if (!key || header(request, 'authorization') !== `Bearer ${key}`) {json(response, 403, {error: 'management key required'}); return;}
    if (request.method !== 'GET') {json(response, 405, {error: 'GET required'}); return;}
    try {json(response, 200, await ctx.im.catalog());}
    catch {json(response, 502, {error: 'model_catalog_failed'});}
  }}), `${channel} model catalog`);
}

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
