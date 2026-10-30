import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import type {MailGatewayFixture} from './fixtures/mail-gateway-worker.ts';

test('durable mail cursors survive transport rotation and SMTP retries cannot duplicate an uncertain delivery', async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({modules: true, scriptPath: resolve('dist/mail-gateway-worker.js'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: {MAIL: {className: 'MailGatewayFixture', useSQLite: true}}}));
  try {
    const namespace = await runtime.getDurableObjectNamespace('MAIL'), gateway = namespace.get(namespace.idFromName('mail')) as unknown as MailGatewayFixture;
    const input = {key: 'tenant/environment/package/email', scope: {tenantId: 'tenant', environmentId: 'environment'}, receipt: {name: 'mail', digest: 'digest', activationId: 'activation'}, connectionId: 'email', version: 'credentials-1',
      spec: {kind: 'mail', address: 'bot@example.com', imap: {host: 'imap.example.com', port: 993, security: 'tls', user: 'bot@example.com', password: 'password'}, smtp: {host: 'smtp.example.com', port: 465, security: 'tls', user: 'bot@example.com', password: 'password'}}};
    const until = async (predicate: (value: Awaited<ReturnType<MailGatewayFixture['fixture']>>) => boolean) => {
      for (let i = 0; i < 200; i++) {const value = await gateway.fixture(); if (predicate(value)) return value; await delay(10);}
      throw new Error('Mailbox gateway did not settle');
    };
    await gateway.open(input); await until(value => value.rows[0]?.cursor === '1');
    await gateway.pollAgain(); await until(value => value.rows[0]?.cursor === '2');
    assert.equal((await gateway.fixture()).received.length, 1, 'an acknowledged batch advances the durable cursor');
    await gateway.open({...input, version: 'credentials-2'});
    await until(value => value.rows[0]?.cursor === '3');
    assert.equal((await gateway.fixture()).received.length, 2, 'same-account rotation resumes the previous cursor');
    const reply = {target: {uid: 10, validity: '42'}, text: 'same answer', deliveryId: 'session:turn-1'};
    const sent = await gateway.mailCall(input.key, 'mailReply', reply) as {messageId: string};
    const retried = await gateway.mailCall(input.key, 'mailReply', reply) as {messageId: string};
    assert.equal(sent.messageId, '<reply-0@example.com>');
    assert.equal(retried.messageId, sent.messageId); assert.equal((await gateway.fixture()).sent, 1);
    await gateway.mailCall(input.key, 'mailReply', {...reply, deliveryId: 'session:turn-2'});
    assert.equal((await gateway.fixture()).sent, 2, 'identical answers from separate turns are both delivered');
    await gateway.fixture('connect');
    await assert.rejects(gateway.mailCall(input.key, 'mailReply', {...reply, deliveryId: 'session:turn-3'}));
    await gateway.fixture('');
    await gateway.mailCall(input.key, 'mailReply', {...reply, deliveryId: 'session:turn-3'});
    assert.equal((await gateway.fixture()).sent, 3, 'authentication failures remain retryable');
    await gateway.fixture('ack');
    await assert.rejects(gateway.mailCall(input.key, 'mailReply', {...reply, deliveryId: 'session:turn-4'}));
    await gateway.fixture('');
    await assert.rejects(gateway.mailCall(input.key, 'mailReply', {...reply, deliveryId: 'session:turn-4'}));
    assert.equal((await gateway.fixture()).sent, 4, 'an uncertain acknowledgement never resends the body');
    await gateway.close(input.key); assert.equal(await gateway.status(input.key), null);
    assert.match(await gateway.closedReplyError(input.key, reply), /not open/);
  } finally {await runtime.dispose();}
});
