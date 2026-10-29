import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

const compiled = await build({entryPoints: ['plugins/im/src/feishu.js'], bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: '.generated/official-ui.source.tsconfig.json'});
const feishu = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles![0]!.text).toString('base64'));

async function fixture(run: (f: {channel: any; calls: any[]; status(key?: string): Promise<any>; fail(stage: string, code?: number): void}) => Promise<void>) {
  const previous = globalThis.fetch, routes = new Map<string, any>(), calls: any[] = [];
  let channel: any, failedStage = '', failureCode = 99991672;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(init.body));
    calls.push({path, method: init.method, body});
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({code: 0, tenant_access_token: 'private-token', expire: 7200});
    const stage = path === '/open-apis/cardkit/v1/cards' ? 'create' : path.includes('/elements/') ? 'update' : path.endsWith('/settings') ? 'finish' : body.msg_type === 'interactive' ? 'markdown' : 'text';
    if (stage === failedStage) return Response.json({code: failureCode, msg: 'private-token private-secret private-answer'});
    return Response.json({code: 0, data: path === '/open-apis/cardkit/v1/cards' ? {card_id: 'test-card'} : {message_id: 'test-message'}});
  }) as typeof fetch;
  const ctx = {
    effect(fn: () => unknown) {fn();},
    im: {channel(_name: string, transport: any) {channel = transport; return () => {}; }},
    webServer: {register(route: any) {routes.set(route.path, route.handler); return () => {}; }},
    storageDomain: {async open() {return {close() {}, global: {get: () => ({}), async set() {}}};}},
    weftConnections: {async close() {}},
  };
  try {
    await feishu.apply(ctx, {enabled: true, connectionMode: 'manual', domain: 'feishu', appId: 'test-app', appSecret: 'private-secret', managementKey: 'management-key'});
    await run({channel, calls, fail(stage, code = 99991672) {failedStage = stage; failureCode = code;}, async status(key = 'management-key') {
      let value: any;
      await routes.get('/feishu/status')({method: 'GET', headers: {authorization: `Bearer ${key}`}}, {setHeader() {}, writeHead() {}, end(body: string) {value = JSON.parse(body);}});
      assert.doesNotMatch(JSON.stringify(value), /private-token|private-secret|private-answer/);
      return value;
    }});
  } finally {globalThis.fetch = previous;}
}

test('manual Feishu callback supports one Markdown streaming card with ordered content and final settings', async () => {
  await fixture(async ({channel, calls, status}) => {
    const card = await channel.startReply({chatId: 'chat', messageId: 'incoming'}, 'dedup-id');
    const created = calls.find(call => call.path === '/open-apis/cardkit/v1/cards');
    assert.equal(created.method, 'POST');
    assert.deepEqual(JSON.parse(created.body.data).body.elements, [{tag: 'markdown', element_id: 'answer', content: '正在思考…'}]);
    assert.equal(JSON.parse(created.body.data).config.streaming_mode, true);
    const sent = calls.find(call => call.path.endsWith('/incoming/reply'));
    assert.equal(sent.body.msg_type, 'interactive');
    assert.equal(sent.body.uuid, 'dedup-id');
    assert.deepEqual(JSON.parse(sent.body.content), {type: 'card', data: {card_id: 'test-card'}});
    await channel.updateReply(card, '**partial**', false);
    await channel.updateReply(card, '**final**\n\n```js\n1 + 1\n```', true);
    const updates = calls.filter(call => call.path.includes('/test-card/'));
    assert.deepEqual(updates.map(call => [call.method, call.body.sequence]), [['PUT', 1], ['PUT', 2], ['PATCH', 3]]);
    assert.equal(updates[1].body.content, '**final**\n\n```js\n1 + 1\n```');
    assert.equal(JSON.parse(updates[2].body.settings).config.streaming_mode, false);
    assert.equal((await status()).reply.mode, 'streaming');
  });
});

test('missing CardKit permission preserves inline Markdown and reports only safe capability-protected diagnostics', async () => {
  await fixture(async ({channel, calls, status, fail}) => {
    fail('create');
    await assert.rejects(channel.startReply({chatId: 'chat'}, 'uuid'));
    const text = '# Title\n\n**bold** [link](https://example.com)\n\n```js\n42\n```';
    await channel.send({chatId: 'chat'}, text);
    const sent = calls.find(call => call.body.msg_type === 'interactive');
    const content = JSON.parse(sent.body.content);
    assert.equal(content.schema, '2.0');
    assert.deepEqual(content.body.elements, [{tag: 'markdown', content: text}]);
    assert.equal(calls.some(call => call.body.msg_type === 'text'), false);
    assert.deepEqual((await status()).reply.failure, {stage: 'create', code: 99991672, status: 200});
    assert.equal((await status()).reply.mode, 'markdown');
    assert.deepEqual(await status('wrong-key'), {error: 'management key required'});
    fail('');
    await channel.startReply({chatId: 'chat'}, 'next-uuid');
    assert.equal((await status()).reply.failure, undefined);
  });
});

test('failed card updates retain the full Markdown answer; rejected inline cards finally fall back to text', async () => {
  await fixture(async ({channel, calls, status, fail}) => {
    const target = {chatId: 'chat', messageId: 'incoming'}, card = await channel.startReply(target, 'uuid');
    fail('update', 300313);
    await assert.rejects(channel.updateReply(card, '**complete answer**', false));
    await channel.send(target, '**complete answer**');
    assert.equal((await status()).reply.failure.stage, 'update');
    assert.equal((await status()).reply.failure.code, 300313);
    assert.deepEqual(JSON.parse(calls.at(-1).body.content).body.elements, [{tag: 'markdown', content: '**complete answer**'}]);
    fail('markdown', 230099);
    await channel.send(target, '**last resort**');
    assert.equal(calls.at(-1).body.msg_type, 'text');
    assert.deepEqual(JSON.parse(calls.at(-1).body.content), {text: '**last resort**'});
    assert.equal((await status()).reply.mode, 'text');
    assert.deepEqual((await status()).reply.failure, {stage: 'markdown', code: 230099, status: 200});
    fail('');
    const next = await channel.startReply(target, 'next-uuid');
    fail('finish', 300317);
    await assert.rejects(channel.updateReply(next, '**finished answer**', true));
    assert.deepEqual((await status()).reply.failure, {stage: 'finish', code: 300317, status: 200});
  });
});
