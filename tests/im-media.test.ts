import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {createCipheriv, createDecipheriv} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const media = await import(new URL('../plugins/im/src/media.js', import.meta.url).href);
const compiled = await build({entryPoints: ['plugins/im/src/core.js'], bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: '.generated/official-ui.source.tsconfig.json',
  // The installed-bundle compiler supplies defineTool as a Host capability too.
  // Its policy/schema enforcement is exercised by im-plugin.test.ts in workerd.
  plugins: [{name: 'host-tool-definition', setup(builder) {
    builder.onResolve({filter: /^@deepseek-ai[/]dsh-tools$/}, () => ({path: 'tools', namespace: 'host-capability'}));
    builder.onLoad({filter: /.*/, namespace: 'host-capability'}, () => ({contents: 'export const defineTool = value => value;'}));
  }}]});
const core = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles![0]!.text).toString('base64'));

test('iLink downloads decrypt image/file bytes, reject foreign hosts and bound streamed bodies', async () => {
  const fetchBefore = globalThis.fetch;
  const key = Buffer.alloc(16, 7), bytes = Buffer.from('exact original bytes');
  const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const calls: string[] = [];
  globalThis.fetch = (async (url: URL) => {calls.push(String(url)); return new Response(encrypted);}) as typeof fetch;
  try {
    const items = [{type: 4, file_item: {file_name: '../document.txt', media: {encrypt_query_param: 'a&b', aes_key: key.toString('base64')}}},
      {type: 2, image_item: {aeskey: key.toString('hex'), media: {encrypt_query_param: 'image'}}}];
    const attachments = media.weixinAttachments({item_list: items});
    assert.equal(attachments[0].name, 'document.txt');
    assert.deepEqual(await attachments[0].load(), bytes);
    assert.deepEqual(await attachments[1].load(), bytes);
    assert.match(calls[0]!, /encrypted_query_param=a%26b/);
    assert.throws(() => media.checkedUrl('https://novac2c.cdn.weixin.qq.com.evil.test/c2c/x', ['novac2c.cdn.weixin.qq.com']));
    await assert.rejects(media.readDownload(new Response(new Uint8Array(33)), 32), /大小限制/);
    await assert.rejects(media.readDownload(new Response(null, {status: 302})), /下载失败/);
  } finally {globalThis.fetch = fetchBefore;}
});

test('iLink file/image upload uses encrypted CDN bytes and native message items with context', async () => {
  const fetchBefore = globalThis.fetch;
  let uploadBody: Buffer | undefined;
  const calls: {endpoint: string; body: any}[] = [];
  const call = async (_base: string, endpoint: string, options: any) => {
    calls.push({endpoint, body: options.body});
    return endpoint.endsWith('getuploadurl') ? {upload_param: 'upload-secret'} : {ret: 0};
  };
  globalThis.fetch = (async (url: URL, options: any) => {assert.match(String(url), /^https:\/\/novac2c.cdn.weixin.qq.com\/c2c\/upload\?/); uploadBody = Buffer.from(options.body); return new Response('', {headers: {'x-encrypted-param': 'download-secret'}});}) as typeof fetch;
  try {
    for (const image of [false, true]) {
      const data = Buffer.from('verbatim content');
      await media.sendWeixinAttachment(call, {baseUrl: 'https://ilinkai.weixin.qq.com', token: 'bot-token'}, {to: 'user', contextToken: 'context'}, {name: 'result.txt', data, image, deliveryId: 'stable-id'});
      const upload = calls.at(-2)!.body, sent = calls.at(-1)!.body.msg;
      assert.equal(upload.media_type, image ? 1 : 3);
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
      assert.deepEqual(Buffer.concat([decipher.update(uploadBody!), decipher.final()]), data);
      assert.equal(sent.client_id, 'stable-id');
      assert.equal(sent.context_token, 'context');
      assert.equal(sent.item_list[0].type, image ? 2 : 4);
    }
  } finally {globalThis.fetch = fetchBefore;}
});

async function fixture() {
  const tables = new Map<string, Map<string, any>>(), cleanup: (() => unknown)[] = [], prompts: any[] = [], uploads: any[] = [], messages: string[] = [], statuses: boolean[] = [], tools: any[] = [];
  let bridge: any, caller = 'session-1';
  const ctx: any = {
    effect(fn: () => (() => unknown)) {const dispose = fn(); cleanup.push(dispose); return () => {};},
    provide(_name: string, service: any) {bridge = service;},
    storageDomain: {async open() {return {close() {}, table(name: string) {
      const rows = new Map<string, any>(); tables.set(name, rows);
      return {get: (key: string) => structuredClone(rows.get(key)), keys: () => rows.keys(), entries: () => rows.entries(),
        async put(key: string, value: any) {rows.set(key, structuredClone(value));}, async delete(key: string) {rows.delete(key);},
        async update(key: string, fn: (current: any) => any) {const value = fn(structuredClone(rows.get(key))); rows.set(key, structuredClone(value)); return value;}};
    }}}},
    sessionController: {create: async () => ({sessionId: 'session-1'}), prompt: async (request: any) => {prompts.push(request);}, callerSessionId: () => caller,
      async uploadAttachment(sessionId: string, options: any, data: Uint8Array) {uploads.push({sessionId, options, data}); return {file: {receiptId: 'file-receipt'}, ...(options.image ? {imageError: '原图已保留'} : {})};},
      async *follow() {await delay(100);}},
    weftSessionEvents: {onTurnEnded: () => () => {}, watch: async () => {}, unwatch: async () => {}},
    tools: {register: (tool: any) => tools.push(tool)},
    fs: {resolve: async (path: string) => ({displayPath: path}), stat: async () => ({type: 'file', size: 3}), readBytes: async () => Buffer.from('abc')},
  };
  core.apply(ctx, {});
  await bridge.ready;
  const channel: any = {send: async (_target: any, text: string) => {messages.push(text);}, typing: async (_target: any, active: boolean) => {statuses.push(active);}};
  bridge.channel('test', channel);
  const receive = (patch: any = {}) => bridge.receive({channel: 'test', conversation: 'chat', sender: 'user', text: '', messageId: crypto.randomUUID(), target: {id: 'chat'}, ...patch});
  const dispose = async () => {for (const fn of cleanup.reverse()) await fn(); for (const task of bridge.followers.values()) await task.pending;};
  return {ctx, bridge, receive, channel, tables, prompts, uploads, messages, statuses, tools, dispose, setCaller: (value: string) => {caller = value;}};
}

test('IM attachments pass access checks before downloading, use scoped receipts, and stop input status on errors', async () => {
  const fx = await fixture(); let loads = 0;
  const attachment = {name: '../in.txt', load: async () => {loads++; return Buffer.from('abc');}};
  try {
    fx.channel.access = () => ({allowed: false});
    assert.equal(await fx.receive({attachments: [attachment]}), 'denied');
    assert.equal(loads, 0);
    assert.equal(fx.uploads.length, 0);
    fx.channel.access = () => ({allowed: true});
    assert.equal(await fx.receive({messageId: 'one', attachments: [attachment]}), 'accepted');
    assert.equal(fx.uploads[0].options.name, 'in.txt');
    assert.equal(fx.uploads[0].sessionId, 'session-1');
    assert.deepEqual(fx.prompts[0].content, [{type: 'text', text: '请查看附件。'}, {type: 'file', receiptId: 'file-receipt'}]);
    assert.equal(await fx.receive({messageId: 'one', attachments: [attachment]}), 'duplicate');
    assert.equal(loads, 1);
    assert.equal(await fx.receive({attachments: Array(11).fill(attachment)}), 'failed');
    assert.equal(loads, 1);
    fx.ctx.sessionController.prompt = async () => {throw new Error('offline');};
    assert.equal(await fx.receive({attachments: [attachment]}), 'failed');
    await fx.bridge.stopActivity('test:chat');
    assert.equal(fx.statuses.at(-1), false);
  } finally {await fx.dispose();}
});

test('file return tool only sends to its authenticated Session binding and reserves uncertain sends', async () => {
  const fx = await fixture(); let sends = 0;
  const exec = {callId: 'tool-1', signal: new AbortController().signal};
  try {
    await fx.receive({text: 'send a file'});
    fx.channel.sendFile = async (target: any, file: any) => {assert.equal(target.id, 'chat'); assert.equal(file.name, 'out.txt'); assert.equal(Buffer.from(file.data).toString(), 'abc'); sends++;};
    assert.equal((await fx.tools[0].execute({path: '/workspace/out.txt'}, exec)).status, 'sent');
    await fx.tools[0].execute({path: '/workspace/out.txt'}, exec);
    assert.equal(sends, 1);
    fx.setCaller('unrelated-session');
    await assert.rejects(fx.tools[0].execute({path: '/workspace/out.txt'}, {...exec, callId: 'foreign'}), /没有绑定/);
    fx.setCaller('session-1');
    fx.channel.sendFile = async () => {sends++; throw new Error('unknown outcome');};
    await assert.rejects(fx.tools[0].execute({path: '/workspace/out.txt'}, {...exec, callId: 'uncertain'}), /unknown outcome/);
    await assert.rejects(fx.tools[0].execute({path: '/workspace/out.txt'}, {...exec, callId: 'uncertain'}), /结果不确定/);
    assert.equal(sends, 2);
  } finally {await fx.dispose();}
});

test('live assistant deltas update a single card and finalize without a duplicate text reply', async () => {
  const fx = await fixture();
  const updates: {text: string; final: boolean}[] = [];
  let release: (() => void) | undefined;
  let starts = 0;
  fx.channel.startReply = async () => {starts++; return {id: 'card', sequence: 0};};
  fx.channel.updateReply = async (_card: any, text: string, final = false) => {updates.push({text, final});};
  fx.ctx.sessionController.follow = async function* () {
    yield {type: 'snapshot', records: [{event: {seq: 0, type: 'turn/start'}}, {event: {seq: 1, type: 'user/message', data: {source: {rpcId: fx.prompts[0].requestId}}}}]};
    yield {type: 'assistant-stream', frame: {type: 'start', attemptId: 'attempt'}};
    yield {type: 'assistant-stream', frame: {type: 'chunk', attemptId: 'attempt', chunk: {type: 'text-delta', text: 'partial'}}};
    await new Promise<void>(resolve => {release = resolve;});
    yield {type: 'event', event: {seq: 2, type: 'assistant/message', data: {message: {content: [{type: 'text', text: 'partial completed'}]}}}};
    yield {type: 'event', event: {seq: 3, type: 'turn/end', data: {reason: 'completed'}}};
  };
  try {
    await fx.receive({text: 'stream it'});
    for (let i = 0; i < 100 && !release; i++) await delay(5);
    assert.ok(updates.some(value => value.text === 'partial' && !value.final));
    assert.equal(updates.some(value => value.final), false);
    release!();
    for (let i = 0; i < 100 && !updates.some(value => value.final); i++) await delay(5);
    assert.deepEqual(updates.at(-1), {text: 'partial completed', final: true});
    assert.equal(starts, 1);
    assert.deepEqual(fx.messages, []);
  } finally {release?.(); await fx.dispose();}
});

test('IM image admission keeps the original file alongside native visual input or its fallback note', async () => {
  const fx = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
  const attachment = {name: 'pixel.png', image: true, load: async () => png};
  try {
    fx.ctx.sessionController.uploadAttachment = async (_session: string, options: any, data: Uint8Array) => {
      assert.equal(options.mediaType, 'image/png');
      return {file: {receiptId: 'original'}, image: {type: 'image', mediaType: 'image/png', data: Buffer.from(data).toString('base64')}};
    };
    assert.equal(await fx.receive({attachments: [attachment]}), 'accepted');
    assert.deepEqual(fx.prompts[0].content.slice(1), [{type: 'file', receiptId: 'original'}, {type: 'image', mediaType: 'image/png', data: png.toString('base64')}]);
    fx.ctx.sessionController.uploadAttachment = async () => ({file: {receiptId: 'original'}, imageError: 'model has no image support'});
    assert.equal(await fx.receive({attachments: [attachment]}), 'accepted');
    assert.deepEqual(fx.prompts[1].content.slice(1), [{type: 'file', receiptId: 'original'}, {type: 'text', text: 'model has no image support'}]);
  } finally {await fx.dispose();}
});


test('a delayed old card cannot overwrite the binding after a new Session starts', async () => {
  const fx = await fixture();
  let release: (() => void) | undefined;
  fx.channel.startReply = async () => {await new Promise<void>(resolve => {release = resolve;}); return {id: 'old-card'};};
  fx.channel.updateReply = async () => {throw new Error('Old card should not update');};
  try {
    await fx.receive({text: 'old question'});
    const pending = fx.bridge.updateCard('test:chat', 'old answer');
    for (let i = 0; i < 100 && !release; i++) await delay(5);
    fx.ctx.sessionController.create = async () => ({sessionId: 'session-2'});
    await fx.receive({text: '/new'});
    release!();
    assert.equal(await pending, false);
    assert.equal(fx.tables.get('conversations')!.get('test:chat').sessionId, 'session-2');
    assert.equal(fx.tables.get('conversations')!.get('test:chat').card, undefined);
  } finally {release?.(); await fx.dispose();}
});
