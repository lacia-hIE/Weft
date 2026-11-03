import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorkerIm} from '../packages/native-plugins/src/im.ts';

test('weftIm hands a bot to the package it is assigned to and to no other', async () => {
  const delivered: unknown[][] = [];
  const im = new WorkerIm({imDeliver: async (consumer, bot, event) => {delivered.push([consumer, bot, event]); return 'delivered';}, imCall: async () => null, imConsumers: async () => []});
  const withdraw = im.service.provide('feishu_0a1b2c', {consumer: '@weft/dsh-superagent', operations: {send: argument => ({echo: argument})}});
  assert.deepEqual(await im.answer('@other/package', 'feishu_0a1b2c', 'send', {text: 'x'}), {handled: false}, 'another package is not answered');
  assert.deepEqual(await im.answer('@weft/dsh-superagent', 'feishu_0a1b2c', 'send', {text: 'x'}), {handled: true, value: {echo: {text: 'x'}}});
  await assert.rejects(im.answer('@weft/dsh-superagent', 'feishu_0a1b2c', 'toString', null), /no toString operation/, 'only declared operations run');
  assert.equal(await im.service.deliver('feishu_0a1b2c', {text: 'hi'}), 'delivered');
  assert.deepEqual(delivered, [['@weft/dsh-superagent', 'feishu_0a1b2c', {text: 'hi'}]], 'an event goes to the assigned package only');
  assert.throws(() => im.service.provide('feishu_0a1b2c', {consumer: '@weft/dsh-superagent', operations: {}}), /provided twice/);
  assert.throws(() => im.service.provide('Feishu', {consumer: '@weft/dsh-superagent', operations: {}}), /bot keys/);
  assert.throws(() => im.service.deliver('qq', {}), /not provided/);
  assert.throws(() => im.service.deliver('feishu_0a1b2c', {at: new Date()}), /lossless JSON/);
  withdraw();
  assert.deepEqual(await im.answer('@weft/dsh-superagent', 'feishu_0a1b2c', 'send', null), {handled: false}, 'a withdrawn bot answers nobody');

  assert.equal(await im.receive('feishu', {}), 'unclaimed', 'a package that does not consume leaves events unclaimed');
  const received: unknown[] = [];
  const stop = im.service.consume({message: (bot, event) => {received.push([bot, event]);}});
  assert.throws(() => im.service.consume({message: () => {}}), /already consumes/);
  assert.equal(await im.receive('feishu', {text: 'hello'}), 'delivered');
  assert.deepEqual(received, [['feishu', {text: 'hello'}]]);
  assert.equal(im.consuming(), true);
  stop();
  assert.equal(im.consuming(), false);
});
