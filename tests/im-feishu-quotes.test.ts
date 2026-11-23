import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

const compiled = await build({entryPoints: ['plugins/im/src/feishu.js'], bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: '.generated/official-ui.source.tsconfig.json'});
const feishu = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles![0]!.text).toString('base64'));

async function fixture(run: (f: {channel: any; calls: any[]; items: any[]; receive(patch?: any): Promise<any>}) => Promise<void>, domain = 'feishu') {
  const previous = globalThis.fetch, calls: any[] = [], items: any[] = [], routes = new Map<string, any>(), received: any[] = [];
  let channel: any;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    const target = new URL(String(url));
    assert.equal(target.hostname, domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn');
    calls.push({path: target.pathname + target.search, ...init});
    if (target.pathname.endsWith('/tenant_access_token/internal')) return Response.json({code: 0, tenant_access_token: 'token', expire: 7200});
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer token');
    if (target.pathname.includes('/resources/')) return new Response('quoted resource bytes');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
    return Response.json({code: 0, data: {items}});
  }) as typeof fetch;
  const ctx = {
    effect(fn: () => unknown) {fn();},
    im: {channel(_name: string, transport: any) {channel = transport; return () => {};}, async receive(message: any) {received.push(message);}},
    webServer: {register(route: any) {routes.set(route.path, route.handler); return () => {}; }},
    storageDomain: {async open() {return {close() {}, global: {get: () => ({}), async set() {}}};}},
    weftConnections: {async close() {}},
  };
  try {
    await feishu.apply(ctx, {enabled: true, connectionMode: 'manual', domain, appId: 'app', appSecret: 'secret', groupResponseMode: 'all'});
    await run({channel, calls, items, async receive(patch = {}) {
      const body = JSON.stringify({header: {event_type: 'im.message.receive_v1'}, event: {
        sender: {sender_id: {open_id: 'user'}, sender_type: 'user'},
        message: {message_id: 'incoming', chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({text: 'explain this'}), parent_id: 'parent', root_id: 'root', ...patch},
      }});
      await routes.get('/feishu')({method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {yield new TextEncoder().encode(body);}},
        {writeHead(code: number) {assert.equal(code, 200);}, end() {}});
      return received.at(-1);
    }});
  } finally {globalThis.fetch = previous;}
}

const original = (msg_type: string, content: unknown, patch = {}) => ({message_id: 'parent', chat_id: 'chat', msg_type,
  sender: {id: 'author'}, body: {content: JSON.stringify(content)}, ...patch});

test('Feishu reads the direct quoted parent, including mentions, rich text and card replies', async () => {
  await fixture(async ({channel, calls, items, receive}) => {
    const message = await receive();
    assert.equal(message.replyTo, 'parent');
    assert.equal(message.text, 'explain this');
    assert.equal(calls.length, 0, 'Fetching remains deferred until the bridge accepts the message');
    items.push(original('text', {text: '@_user_1 original'}, {mentions: [{key: '@_user_1', name: 'Alice'}]}));
    assert.deepEqual(await channel.readReply(message), {senderId: 'author', text: '@Alice original', attachments: []});
    assert.equal(calls.at(-1).path, '/open-apis/im/v1/messages/parent');
    for (const [type, content, text] of [
      ['post', {zh_cn: {title: 'Title', content: [[{tag: 'text', text: 'rich text'}]]}}, 'Title\nrich text'],
      ['interactive', {title: 'Card', elements: [[{tag: 'text', text: 'answer'}, {tag: 'a', text: 'link'}]]}, 'Card\nanswerlink'],
      ['interactive', {schema: '2.0', body: {elements: [{tag: 'markdown', content: '**streamed answer**'}]}}, '**streamed answer**'],
    ]) {
      items[0] = original(type as string, content);
      assert.equal((await channel.readReply(message)).text, text);
    }
  });
});

test('Lark quoted image/file/post downloads use the original message resource path', async () => {
  await fixture(async ({channel, calls, items, receive}) => {
    const message = await receive({chat_type: 'group'});
    for (const [type, content, image] of [
      ['image', {image_key: 'image/key'}, true],
      ['file', {file_key: 'file/key', file_name: 'quoted.txt'}, false],
      ['post', {content: [[{tag: 'img', image_key: 'post/key'}]]}, true],
    ]) {
      items[0] = original(type as string, content);
      const reply = await channel.readReply(message);
      assert.equal(reply.attachments[0].image, image);
      assert.equal(new TextDecoder().decode(await reply.attachments[0].load()), 'quoted resource bytes');
      assert.match(calls.at(-1).path, /^\/open-apis\/im\/v1\/messages\/parent\/resources\/.*%2Fkey\?type=(image|file)$/);
    }
  }, 'lark');
});

test('quoted reads reject unrelated messages and omit withdrawn content and resources', async () => {
  await fixture(async ({channel, items, receive}) => {
    const message = await receive();
    for (const patch of [{chat_id: 'other-chat'}, {message_id: 'other-message'}]) {
      items[0] = original('text', {text: 'unrelated'}, patch);
      await assert.rejects(channel.readReply(message), /unavailable/);
    }
    items[0] = original('file', {file_key: 'withdrawn', file_name: 'withdrawn.txt'}, {deleted: true});
    assert.deepEqual(await channel.readReply(message), {text: '[消息已撤回]'});
  });
});
