import {z} from 'zod';
import {ImapFlow, createSocketsTransport, type SocketsConnect} from 'imapflow';
import {simpleParser} from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import {destination} from '../../native-plugins/src/network.ts';

const line = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value));
const server = z.object({host: line, port: z.number().int().min(1).max(65535), security: z.enum(['tls', 'starttls']), user: line,
  password: z.string().min(1).max(4096), auth: z.enum(['password', 'oauth2']).default('password')}).strict();
export const mailSpec = z.object({kind: z.literal('mail'), address: line.email(), imap: server, smtp: server,
  mailbox: line.default('INBOX')}).strict().superRefine((spec, ctx) => {
  for (const [name, endpoint] of [['imap', spec.imap], ['smtp', spec.smtp]] as const) {
    try {destination(`https://${endpoint.host}`); if (endpoint.host.includes('/') || endpoint.host.includes('@') || endpoint.host.includes(':') || endpoint.port === 25) throw new Error();}
    catch {ctx.addIssue({code: 'custom', path: [name, 'host'], message: 'A public mail hostname and submission port are required'});}
  }
});
export type MailSpec = z.infer<typeof mailSpec>;
export const mailIdentity = (spec: MailSpec) => JSON.stringify([spec.address.toLowerCase(), spec.imap.host.toLowerCase(), spec.imap.user, spec.mailbox]);
export const mailTarget = z.object({uid: z.number().int().positive(), validity: z.string().regex(/^\d{1,30}$/)}).strict();
export const mailReply = z.object({target: mailTarget, text: z.string().max(1_000_000), deliveryId: line.optional(),
  attachment: z.object({name: line, base64: z.string().max(13_981_016).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict().optional()}).strict();
const MAX_SOURCE = 24 * 1024 * 1024, MAX_FILE = 10 * 1024 * 1024;
type Cursor = {validity: string; uid: number};

/** Only Host code opens TCP sockets; plugins never receive raw socket authority. */
export class MailTransport {
  constructor(private readonly connect: SocketsConnect) {}
  private async client<T>(spec: MailSpec, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const endpoint = spec.imap;
    const client = new ImapFlow({host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'tls',
      ...(endpoint.security === 'starttls' ? {doSTARTTLS: true} : {}), auth: endpoint.auth === 'oauth2' ? {user: endpoint.user, accessToken: endpoint.password} : {user: endpoint.user, pass: endpoint.password},
      transport: createSocketsTransport(this.connect), logger: false, disableAutoIdle: true, disableCompression: true,
      maxLineLength: 262_144, maxLiteralSize: MAX_SOURCE + 1, maxResponseSize: MAX_SOURCE + 1_048_576, maxResponseTokens: 20_000,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000});
    client.on('error', () => {});
    const deadline = setTimeout(() => client.close(), 60_000);
    try {await client.connect(); await client.mailboxOpen(spec.mailbox, {readOnly: true}); return await work(client);}
    finally {clearTimeout(deadline); client.close();}
  }
  /** The first cursor starts at UIDNEXT, so enabling a mailbox never replays old mail. */
  async poll(spec: MailSpec, rawCursor: string): Promise<{cursor: string; messages: unknown[]}> {
    return this.client(spec, async client => {
      if (!client.mailbox) throw new Error('Mailbox is unavailable');
      const validity = String(client.mailbox.uidValidity);
      let cursor: Cursor | undefined;
      try {cursor = JSON.parse(rawCursor) as Cursor;} catch { /* First connection. */ }
      if (!cursor || cursor.validity !== validity || !Number.isSafeInteger(cursor.uid)) return {cursor: JSON.stringify({validity, uid: Math.max(0, client.mailbox.uidNext - 1)}), messages: []};
      const uids = await client.search({uid: `${cursor.uid + 1}:*`}, {uid: true});
      const messages: unknown[] = [];
      for (const uid of (uids || []).filter(uid => uid > cursor!.uid).sort((a, b) => a - b).slice(0, 10)) {
        const message = await this.read(client, spec, {uid, validity});
        if (message) {const {parsed: _, ...publicMessage} = message; messages.push(publicMessage);}
        cursor.uid = uid;
      }
      return {cursor: JSON.stringify(cursor), messages};
    });
  }
  private async read(client: ImapFlow, spec: MailSpec, target: z.infer<typeof mailTarget>) {
    if (!client.mailbox || String(client.mailbox.uidValidity) !== target.validity) throw new Error('Mailbox UID validity changed');
    const metadata = await client.fetchOne(target.uid, {size: true, envelope: true}, {uid: true});
    if (!metadata || !metadata.envelope || (metadata.size ?? MAX_SOURCE + 1) > MAX_SOURCE) return null;
    const sender = metadata.envelope.from;
    if (sender?.length !== 1 || !sender[0]?.address || sender[0].address.toLowerCase() === spec.address.toLowerCase()) return null;
    const message = await client.fetchOne(target.uid, {source: {maxLength: MAX_SOURCE + 1}}, {uid: true});
    if (!message || !message.source || message.source.length > MAX_SOURCE) return null;
    const parsed = await simpleParser(message.source, {skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true});
    // RFC 3834: suppress automatic replies, bounces, bulk/list mail and our own output.
    const auto = String(parsed.headers.get('auto-submitted') ?? 'no').toLowerCase();
    if (auto !== 'no' || /^(bulk|list|junk)$/i.test(String(parsed.headers.get('precedence') ?? '')) || parsed.headers.has('list')
      || parsed.headers.has('x-weft-im') || parsed.headerLines.some(header => header.key === 'return-path' && /^return-path:\s*<>\s*$/i.test(header.line))) return null;
    const messageId = parsed.messageId;
    if (!messageId || /[\r\n\0]/.test(messageId)) return null;
    const from = sender[0].address.toLowerCase();
    if (!z.string().email().safeParse(from).success || /[<>\r\n\0]/.test(from)) return null;
    return {target, messageId, from, name: sender[0].name ?? '', subject: (parsed.subject ?? '').slice(0, 512),
      text: (parsed.text ?? '').slice(0, 100_000), references: (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).slice(-50),
      inReplyTo: parsed.inReplyTo, date: parsed.date?.toISOString(), account: mailIdentity(spec),
      attachments: parsed.attachments.map((file, index) => ({index, name: file.filename || 'attachment', type: file.contentType, size: file.size})), parsed};
  }
  async attachment(spec: MailSpec, raw: unknown): Promise<{base64: string}> {
    const {target, index} = z.object({target: mailTarget, index: z.number().int().min(0).max(999)}).strict().parse(raw);
    return this.client(spec, async client => {
      const file = (await this.read(client, spec, target))?.parsed.attachments[index];
      if (!file || file.size > MAX_FILE) throw new Error('Mail attachment is unavailable or exceeds 10 MiB');
      return {base64: file.content.toString('base64')};
    });
  }
  async check(spec: MailSpec): Promise<void> {
    await this.client(spec, async () => {});
    await this.smtp(spec, async () => {});
  }
  async reply(spec: MailSpec, raw: unknown, reserve?: () => void): Promise<{messageId: string}> {
    const input = mailReply.parse(raw);
    // The recipient and thread headers are taken from the original IMAP message, never from a model or Reply-To.
    const original = await this.client(spec, client => this.read(client, spec, input.target));
    if (!original) throw new Error('Original mail is unavailable or cannot receive automatic replies');
    const messageId = `<${crypto.randomUUID()}@${spec.address.split('@')[1]}>`;
    const attachment = input.attachment && Buffer.from(input.attachment.base64, 'base64');
    if (attachment && attachment.length > MAX_FILE) throw new Error('Attachment exceeds 10 MiB');
    const mime = await new MailComposer({from: spec.address, to: original.from, subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
      text: input.text, messageId, inReplyTo: original.messageId, references: [...original.references, original.messageId],
      headers: {'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-Weft-IM': 'email'},
      disableFileAccess: true, disableUrlAccess: true,
      ...(attachment ? {attachments: [{filename: input.attachment!.name, content: attachment}]} : {})}).compile().build();
    await this.smtp(spec, async command => {
      await command(`MAIL FROM:<${spec.address}>`, 250); await command(`RCPT TO:<${original.from}>`, 250, 251);
      await command('DATA', 354);
      reserve?.();
      await command(mime.toString('utf8').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..').replace(/\r\n$/, '') + '\r\n.', 250);
    });
    return {messageId};
  }
  private async smtp<T>(spec: MailSpec, work: (command: (line: string, ...codes: number[]) => Promise<string>) => Promise<T>): Promise<T> {
    const endpoint = spec.smtp;
    let socket = this.connect({hostname: endpoint.host, port: endpoint.port}, {secureTransport: endpoint.security === 'tls' ? 'on' : 'starttls'});
    void socket.closed?.catch(() => {});
    let reader: ReturnType<typeof socket.readable.getReader> | undefined, writer: ReturnType<typeof socket.writable.getWriter> | undefined, buffer = '';
    const timer = setTimeout(() => {void Promise.resolve(socket.close()).catch(() => {});}, 30_000);
    const bind = async () => {await socket.opened; reader = socket.readable.getReader(); writer = socket.writable.getWriter();};
    const response = async (...codes: number[]) => {
      let lines = '', count = 0;
      for (;;) {
        while (!buffer.includes('\r\n')) {
          const chunk = await reader!.read(); if (chunk.done || !chunk.value) throw new Error('SMTP connection closed');
          buffer += Buffer.from(chunk.value).toString('latin1'); if (buffer.length > 65_536) throw new Error('SMTP response too large');
        }
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2); lines += line + '\n';
        if (++count > 100 || !/^\d{3}[ -]/.test(line)) throw new Error('Invalid SMTP response');
        if (line[3] === ' ') {if (!codes.includes(Number(line.slice(0, 3)))) throw new Error('SMTP command rejected'); return lines;}
      }
    };
    const command = async (line: string, ...codes: number[]) => {await writer!.write(Buffer.from(line + '\r\n')); return response(...codes);};
    try {
      await bind(); await response(220); let hello = await command('EHLO weft.local', 250);
      if (endpoint.security === 'starttls') {
        if (!/\bSTARTTLS\b/i.test(hello)) throw new Error('SMTP server requires TLS support');
        await command('STARTTLS', 220); reader!.releaseLock(); writer!.releaseLock(); buffer = '';
        socket = socket.startTls(); void socket.closed?.catch(() => {}); await bind(); hello = await command('EHLO weft.local', 250);
      }
      if (endpoint.auth === 'oauth2') {
        const auth = Buffer.from(`user=${endpoint.user}\x01auth=Bearer ${endpoint.password}\x01\x01`).toString('base64');
        await command('AUTH XOAUTH2 ' + auth, 235);
      } else if (/\bPLAIN\b/i.test(hello)) {
        await command('AUTH PLAIN ' + Buffer.from(`\0${endpoint.user}\0${endpoint.password}`).toString('base64'), 235);
      } else {
        await command('AUTH LOGIN', 334); await command(Buffer.from(endpoint.user).toString('base64'), 334); await command(Buffer.from(endpoint.password).toString('base64'), 235);
      }
      return await work(command);
    } finally {clearTimeout(timer); try {reader?.releaseLock(); writer?.releaseLock(); await socket.close();} catch { /* Already closed. */ }}
  }
}
