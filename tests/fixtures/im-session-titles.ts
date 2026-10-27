import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import SessionStore, {SessionId} from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionTitle, {SessionTitleProviderId} from '@deepseek-ai/dsh-session-title';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {installImSessionTitles} from '../../packages/harness-runtime/src/im-session-titles.ts';

export async function verifyImSessionTitles() {
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(SessionTitle, {fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80});
    installImSessionTitles(ctx);
    const session = ctx.sessions.create(SessionId('im-titles'));
    const message = session.append('user/message', createUserMessage({content: [{type: 'text', text: '安排下周的项目讨论'}], source: {kind: 'user', rpcId: ('feishu-' + crypto.randomUUID()) as import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId}}), {surfaceOp: 'append'});
    await delay(0);
    assert.equal(ctx.sessionTitle.get(session)?.title, '飞书 · 安排下周的项目讨论');
    assert.deepEqual(ctx.sessionTitle.get(session)?.source, {kind: 'fallback'});
    assert.deepEqual(ctx.sessionTitle.get(session)?.messageSeqs, [message.seq]);
    const provider = SessionTitleProviderId('im-title-test');
    let revision = 0;
    const unregister = ctx.sessionTitle.register({id: provider, automatic: 'all-prompts', async generate({messages}) {
      return {title: `项目讨论 ${++revision}`, messageSeqs: messages.map(item => item.seq)};
    }});
    await ctx.sessionTitle.refresh(session);
    await delay(0);
    assert.equal(ctx.sessionTitle.get(session)?.title, '飞书 · 项目讨论 1');
    assert.deepEqual(ctx.sessionTitle.get(session)?.source, {kind: 'provider', provider});
    await ctx.sessionTitle.refresh(session);
    await delay(0);
    assert.equal(ctx.sessionTitle.get(session)?.title, '飞书 · 项目讨论 2');
    ctx.sessionTitle.rename(session, '我的项目');
    await delay(0);
    assert.equal(ctx.sessionTitle.get(session)?.title, '飞书 · 我的项目');
    assert.deepEqual(ctx.sessionTitle.get(session)?.source, {kind: 'user'});
    assert.deepEqual(ctx.sessionTitle.get(session)?.messageSeqs, []);
    await unregister();
    const ordinary = ctx.sessions.create(SessionId('ordinary'));
    ordinary.append('user/message', createUserMessage({content: [{type: 'text', text: '微信 · 普通网页会话'}], source: {kind: 'user', rpcId: crypto.randomUUID() as import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId}}), {surfaceOp: 'append'});
    await delay(0);
    assert.equal(ctx.sessionTitle.get(ordinary)?.title, '微信 · 普通网页会话');
    assert.equal(ordinary.snapshotEvents().filter(event => event.type === 'session/title').length, 1);
    const inherited = session.snapshotEvents();
    const fork = ctx.sessions.create(SessionId('web-fork'), {seed: inherited, meta: {parentSession: session.id, isSeeded: true}, inheritedEventCount: inherited.length as typeof session.inheritedEventCount});
    fork.append('session/title', {title: '网页分支', source: {kind: 'user'}, messageSeqs: []});
    await delay(0);
    assert.equal(ctx.sessionTitle.get(fork)?.title, '网页分支');
    session.append('session/title', {title: '过期结果', source: {kind: 'fallback'}, messageSeqs: [message.seq]});
    ctx.sessionTitle.rename(session, '刚刚手动重命名');
    await delay(0);
    assert.equal(ctx.sessionTitle.get(session)?.title, '飞书 · 刚刚手动重命名');
    assert.deepEqual(ctx.sessionTitle.get(session)?.source, {kind: 'user'});
  } finally {await ctx.fiber.dispose();}
}
