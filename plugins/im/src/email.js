import Schema from '@deepseek-ai/schemastery';
import {botSettings, channelSettings, managementKey, registerModelCatalog} from './management.js';
import {base64, fileName} from './media.js';
import {header, json, hex, sha256} from './shared.js';

export const name = 'dsh-im-email';
export const inject = ['im', 'webServer', 'storageDomain', 'weftConnections'];
const endpoint = (prefix, port) => ({
  [prefix + 'Host']: Schema.string().default(''),
  [prefix + 'Port']: Schema.natural().min(1).max(65535).default(port),
  [prefix + 'Security']: Schema.union(['tls', 'starttls']).default('tls'),
  [prefix + 'User']: Schema.string().default(''),
  [prefix + 'Password']: Schema.string().role('secret').default(''),
  [prefix + 'Auth']: Schema.union(['password', 'oauth2']).default('password'),
});
export const Config = Schema.object({
  ...botSettings(), managementKey: managementKey(), enabled: Schema.boolean().default(false),
  address: Schema.string().default(''), mailbox: Schema.string().default('INBOX'),
  ...endpoint('imap', 993), ...endpoint('smtp', 465),
  allowedSenders: Schema.array(Schema.string()).default([]),
});
const DOMAIN = {name: 'im_email', version: 1, tables: {threads: {valueSchema: {parse: value => value}}}};

/** IMAP inbox → a native Session → one SMTP reply, with no public callback or extra relay. */
export async function apply(ctx, config) {
  registerModelCatalog(ctx, 'email', config);
  let connection;
  const domain = await ctx.storageDomain.open(DOMAIN), threads = domain.table('threads');
  ctx.effect(() => () => domain.close(), 'email thread storage');
  const spec = {kind: 'mail', address: config.address.trim().toLowerCase(), mailbox: config.mailbox || 'INBOX'};
  for (const prefix of ['imap', 'smtp']) spec[prefix] = {host: config[prefix + 'Host'].trim(), port: config[prefix + 'Port'], security: config[prefix + 'Security'],
    user: config[prefix + 'User'].trim() || spec.address, password: config[prefix + 'Password'], auth: config[prefix + 'Auth']};
  const account = JSON.stringify([spec.address, spec.imap.host.toLowerCase(), spec.imap.user, spec.mailbox]);
  const key = (sender, id) => JSON.stringify([account, sender, id]);
  const remember = async (sender, id, conversation) => {
    await threads.put(key(sender, id), {conversation});
    const excess = [...threads.keys()].slice(0, Math.max(0, [...threads.keys()].length - 4000));
    for (const id of excess) await threads.delete(id);
  };
  const reply = async (target, text, attachment, deliveryId) => {
    if (!connection || target.account !== account) throw new Error('邮箱账号已改变，请从当前邮箱发送新邮件。');
    await connection.ready;
    const result = await connection.replyMail({target: target.location, text, ...(attachment ? {attachment} : {}), ...(deliveryId ? {deliveryId} : {})});
    await remember(target.sender, result.messageId, target.conversation);
  };
  for (const [path, method] of [['status', 'GET'], ['disconnect', 'POST']]) {
    ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/email/${path}`, handler: async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      if (!config.managementKey || header(request, 'authorization') !== `Bearer ${config.managementKey}`) {json(response, 403, {error: 'management key required'}); return;}
      if (request.method !== method) {json(response, 405, {error: `${method} required`}); return;}
      try {
        if (path === 'disconnect') {await ctx.weftConnections.close('email'); await ctx.im.clear('email'); json(response, 200, {state: 'idle'}); return;}
        if (!config.enabled) {json(response, 200, {state: 'disabled'}); return;}
        await connection.ready; await connection.checkMail();
        const status = await connection.status();
        json(response, 200, {state: 'ready', botId: spec.address, checkedAt: Date.now(), ...(status?.tracked.error ? {error: 'mail_connection_failed'} : {})});
      } catch {json(response, 502, {error: 'mail_connection_failed'});}
    }}), `email ${path}`);
  }
  if (!config.enabled) {await ctx.weftConnections.close('email').catch(() => {}); return;}
  const access = channelSettings(config, () => undefined, () => spec.address);
  // Email addresses are case insensitive in the settings policy, including command overrides.
  const normalized = {...config, allowedSenders: (config.allowedSenders ?? []).map(id => id.trim().toLowerCase()),
    ...(config.accessPolicy ? {accessPolicy: JSON.parse(JSON.stringify(config.accessPolicy), (key, value) => key === 'id' && typeof value === 'string' ? value.trim().toLowerCase() : value)} : {})};
  access.access = channelSettings(normalized, () => undefined, () => spec.address).access;
  ctx.effect(() => ctx.im.channel('email', {...access,
    maxChars: Number.MAX_SAFE_INTEGER,
    send: (target, text, options) => reply(target, text, undefined, options?.deliveryId),
    sendFile: (target, file) => {file.signal?.throwIfAborted(); return reply(target, '', {name: fileName(file.name), base64: base64(file.data)}, file.deliveryId);},
  }), 'email channel');
  connection = ctx.weftConnections.mail('email', {
    version: hex(await sha256(JSON.stringify(spec))), open: () => spec,
    async response(body) {
      for (const mail of body.messages ?? []) {
        if (mail.account !== account || !mail.from || !mail.messageId) continue;
        // Unlike chat platforms, rejecting unknown email with a reply can cause backscatter.
        if (!access.access({sender: mail.from}, false).allowed) continue;
        const references = [...(mail.references ?? []), mail.inReplyTo].filter(Boolean);
        const conversation = references.map(id => threads.get(key(mail.from, id))?.conversation).find(Boolean) || mail.messageId;
        await remember(mail.from, mail.messageId, conversation);
        const target = {account, sender: mail.from, conversation, location: mail.target};
        await ctx.im.receive({channel: 'email', conversation: JSON.stringify([account, mail.from, conversation]), sender: mail.from, senderName: mail.name,
          title: mail.subject, threadId: conversation, sentAt: mail.date, messageId: JSON.stringify([account, mail.target.validity, mail.target.uid]),
          text: mail.text || mail.subject, target,
          attachments: (mail.attachments ?? []).map(item => ({name: fileName(item.name), image: String(item.type).startsWith('image/'), load: async () => {
            if (item.size > 10 * 1024 * 1024) throw new Error('邮件附件超过 10 MiB。');
            const file = await connection.mailAttachment({target: mail.target, index: item.index});
            return Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
          }}))});
      }
    },
  });
}
