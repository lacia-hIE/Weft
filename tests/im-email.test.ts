import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {simpleParser} from 'mailparser';
import {MailTransport, mailSpec} from '../packages/connection-gateway/src/mail.ts';
import type {SocketsConnect, SocketsApiSocket} from 'imapflow';

/** A byte-stream IMAP/SMTP fixture exercises the real protocol/MIME clients, without sending external email. */
function mailboxFixture(security: 'tls' | 'starttls' = 'tls') {
  const messages = new Map<number, string>(), sent: string[] = [], recipients: string[] = [], traffic: string[] = [];
  let validity = '42', uidNext = 10;
  const connect: SocketsConnect = (address, options) => {
    const imap = address.port === 993, encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>, buffer = '', data = false, mime = '', tls = options?.secureTransport === 'on', closed = false;
    assert.equal(options?.secureTransport, security === 'tls' ? 'on' : 'starttls');
    const send = (line: string) => controller.enqueue(encoder.encode(line + '\r\n'));
    const readable = new ReadableStream<Uint8Array>({start(c) {controller = c; send(imap ? '* OK fixture IMAP ready' : '220 fixture ESMTP');}});
    const writable = new WritableStream<Uint8Array>({write(chunk) {
      buffer += Buffer.from(chunk).toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2); traffic.push(line);
        if (imap) {
          const [tag, ...parts] = line.split(' '), command = parts.join(' '), upper = command.toUpperCase();
          if (/CAPABILITY/.test(upper)) send('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR' + (tls ? '' : ' STARTTLS'));
          else if (/^STARTTLS/.test(upper)) {send(tag + ' OK Begin TLS'); continue;}
          else if (/^(LOGIN|AUTHENTICATE)/.test(upper)) assert.equal(tls, true, 'Never authenticate over plaintext');
          else if (/^LIST/.test(upper)) send('* LIST () "/" "INBOX"');
          else if (/^(EXAMINE|SELECT)/.test(upper)) {
            send('* FLAGS (\\Seen)'); send('* ' + messages.size + ' EXISTS'); send('* OK [UIDVALIDITY ' + validity + '] valid'); send('* OK [UIDNEXT ' + uidNext + '] next');
          } else if (/^UID SEARCH/.test(upper)) send('* SEARCH ' + [...messages.keys()].join(' '));
          else if (/^UID FETCH/.test(upper)) {
            const uid = Number(parts[2]), source = messages.get(uid);
            if (source) {
              if (/BODY/.test(upper)) send(`* 1 FETCH (UID ${uid} BODY[]<0> {${Buffer.byteLength(source)}}\r\n${source})`);
              else send(`* 1 FETCH (UID ${uid} RFC822.SIZE ${Buffer.byteLength(source)} ENVELOPE ("Fri, 30 Oct 2026 10:00:00 +0000" "Hello" (("Alice" NIL "alice" "example.com")) NIL NIL ((NIL NIL "bot" "example.com")) NIL NIL NIL "<in-${uid}@example.com>"))`);
            }
          }
          send(tag + ' OK completed');
        } else if (data) {
          if (line === '.') {sent.push(mime); mime = ''; data = false; send('250 queued');} else mime += line.replace(/^\.\./, '.') + '\r\n';
        } else if (/^EHLO/.test(line)) {send('250-fixture'); if (!tls) send('250-STARTTLS'); send('250 AUTH PLAIN LOGIN XOAUTH2');}
        else if (line === 'STARTTLS') send('220 Begin TLS');
        else if (/^AUTH /.test(line)) {assert.equal(tls, true); send('235 authenticated');}
        else if (/^RCPT TO:/.test(line)) {recipients.push(line); send('250 recipient');}
        else if (/^MAIL FROM:/.test(line)) send('250 sender');
        else if (line === 'DATA') {data = true; send('354 send message');}
        else throw new Error('Unexpected SMTP command ' + line);
      }
    }});
    const socket: SocketsApiSocket = {readable, writable, opened: Promise.resolve({}), closed: new Promise(() => {}),
      async close() {if (!closed) {closed = true; controller.close();}}, startTls() {tls = true; return socket;}};
    return socket;
  };
  const spec = mailSpec.parse({kind: 'mail', address: 'bot@example.com', imap: {host: 'imap.example.com', port: 993, user: 'bot@example.com', password: 'secret', security},
    smtp: {host: 'smtp.example.com', port: 465, user: 'bot@example.com', password: 'secret', security}});
  const add = (uid: number, extra = '', body = 'hello') => {uidNext = uid + 1; messages.set(uid, `From: Alice <alice@example.com>\r\nTo: bot@example.com\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nMessage-ID: <in-${uid}@example.com>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);};
  return {transport: new MailTransport(connect), spec, add, sent, recipients, traffic, resetValidity() {validity = '99';}};
}

for (const security of ['tls', 'starttls'] as const) test(`mail uses ${security}, skips history, decodes MIME and replies to the original sender in one thread`, async () => {
  const f = mailboxFixture(security);
  f.add(9);
  const initial = await f.transport.poll(f.spec, '');
  assert.deepEqual(initial.messages, []);
  f.add(10, 'Reply-To: attacker@evil.example\r\nCc: third@example.com\r\n');
  const batch = await f.transport.poll(f.spec, initial.cursor), message = batch.messages[0] as any;
  assert.equal(batch.messages.length, 1); assert.equal(message.subject, '你好'); assert.equal(message.from, 'alice@example.com');
  assert.equal(message.parsed, undefined); assert.equal(message.messageId, '<in-10@example.com>');
  const answer = '中文 **answer**\n.dot\n' + 'large answer '.repeat(2000);
  await f.transport.reply(f.spec, {target: message.target, text: answer, attachment: {name: '结果.txt', base64: Buffer.from('exact original bytes').toString('base64')}});
  assert.deepEqual(f.recipients, ['RCPT TO:<alice@example.com>']);
  assert.equal(f.sent.length, 1);
  const reply = await simpleParser(f.sent[0]!);
  assert.equal(reply.inReplyTo, '<in-10@example.com>'); assert.match(reply.text!, /中文 \*\*answer\*\*/);
  assert.equal(reply.attachments[0]!.content.toString(), 'exact original bytes'); assert.equal(reply.attachments[0]!.filename, '结果.txt');
  assert.equal(reply.headers.get('auto-submitted'), 'auto-replied'); assert.equal(reply.cc, undefined);
  assert.deepEqual((await f.transport.poll(f.spec, batch.cursor)).messages, [], 'UID cursor prevents duplicates');
  f.resetValidity(); assert.deepEqual((await f.transport.poll(f.spec, batch.cursor)).messages, [], 'UIDVALIDITY reset starts fresh');
});

test('automatic and mailing-list mail cannot trigger reply loops; endpoints must be public and encrypted', async () => {
  const f = mailboxFixture(), initial = await f.transport.poll(f.spec, '');
  f.add(10, 'Auto-Submitted: auto-replied\r\n'); f.add(11, 'List-ID: list.example.com\r\n'); f.add(12, 'Precedence: bulk\r\n');
  assert.deepEqual((await f.transport.poll(f.spec, initial.cursor)).messages, []);
  await assert.rejects(f.transport.reply(f.spec, {target: {uid: 10, validity: '42'}, text: 'loop'}));
  for (const host of ['localhost', '127.0.0.1', 'mail.internal', '[::1]', 'imap.example.com:443']) assert.equal(mailSpec.safeParse({...f.spec, imap: {...f.spec.imap, host}}).success, false);
  assert.equal(mailSpec.safeParse({...f.spec, smtp: {...f.spec.smtp, security: 'none'}}).success, false);
  assert.equal(mailSpec.safeParse({...f.spec, smtp: {...f.spec.smtp, port: 25}}).success, false);
});

test('email plugin binds sender-scoped threads, guards management routes and loads attachments only on demand', async () => {
  const compiled = await build({entryPoints: ['plugins/im/src/email.js'], bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: '.generated/official-ui.source.tsconfig.json'});
  const plugin = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles![0]!.text).toString('base64'));
  const threads = new Map<string, any>(), routes = new Map<string, any>(), received: any[] = [], replies: any[] = []; let channel: any, handlers: any, loads = 0;
  const connection = {ready: Promise.resolve(), async replyMail(input: any) {replies.push(input); return {messageId: '<out@example.com>'};}, async mailAttachment() {loads++; return {base64: Buffer.from('file bytes').toString('base64')};}, async status() {return {tracked: {}};}, async checkMail() {}};
  const ctx = {effect: (fn: () => unknown) => fn(), storageDomain: {async open() {return {close() {}, table() {return {get: (id: string) => threads.get(id), keys: () => threads.keys(), async put(id: string, value: any) {threads.set(id, value);}, async delete(id: string) {threads.delete(id);}};}};}},
    webServer: {register(route: any) {routes.set(route.path, route.handler);}},
    im: {channel(_id: string, transport: any) {channel = transport;}, async receive(message: any) {received.push(message);}},
    weftConnections: {mail(_id: string, h: any) {handlers = h; return connection;}}};
  await plugin.apply(ctx, {enabled: true, address: 'bot@example.com', imapHost: 'imap.example.com', imapPort: 993, imapSecurity: 'tls', imapUser: '', imapPassword: 'secret', imapAuth: 'password', smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecurity: 'tls', smtpUser: '', smtpPassword: 'secret', smtpAuth: 'password', managementKey: 'management', permissionPreset: 'read-only', allowedSenders: ['ALICE@example.com']});
  const spec = handlers.open(), account = JSON.stringify(['bot@example.com', 'imap.example.com', 'bot@example.com', 'INBOX']);
  const mail = {account, from: 'alice@example.com', messageId: '<in@example.com>', subject: 'subject', text: 'hello', target: {uid: 1, validity: '42'}, attachments: [{index: 0, name: 'file.txt', type: 'text/plain', size: 10}]};
  await handlers.response({messages: [mail]}); assert.equal(loads, 0);
  assert.equal(channel.access({sender: 'alice@example.com'}).allowed, true); assert.equal(channel.access({sender: 'other@example.com'}).allowed, false);
  assert.equal(channel.permissionPreset, 'read-only'); assert.equal(spec.imap.user, 'bot@example.com');
  assert.equal(Buffer.from(await received[0].attachments[0].load()).toString(), 'file bytes'); assert.equal(loads, 1);
  await channel.send(received[0].target, 'one complete answer'); assert.equal(replies.length, 1);
  await handlers.response({messages: [{...mail, messageId: '<next@example.com>', target: {uid: 2, validity: '42'}, references: ['<out@example.com>']}]});
  assert.equal(received[1].conversation, received[0].conversation);
  await handlers.response({messages: [{...mail, from: 'other@example.com', messageId: '<other@example.com>', target: {uid: 3, validity: '42'}, references: ['<out@example.com>']}]});
  assert.equal(received.length, 2, 'unknown senders are silently ignored without triggering a denial email');
  await assert.rejects(channel.send({...received[0].target, account: 'another mailbox'}, 'wrong account'));
  let code = 0; await routes.get('/email/status')({method: 'GET', headers: {}}, {setHeader() {}, writeHead(status: number) {code = status;}, end() {}}); assert.equal(code, 403);
});
