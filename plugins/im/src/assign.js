/**
 * A bot assigned to another package answers there instead of in IM Sessions:
 * its operations are offered to that package through `weftIm`, and each inbound
 * event goes to it as one channel-independent record:
 * `{kind, messageId, chatId, direct, sender: {id, name?, bot}, mentioned, text, at, target, ...}`.
 * `target` is opaque; the package passes it back to `send`.
 * @param {Record<string, (argument: any) => unknown>} operations - operations besides `send`, such as `read`.
 * @returns the inbound handler, or undefined while the bot answers in IM Sessions.
 */
export function assignment(ctx, bot, config, operations = {}) {
  if (!config.consumer) return undefined;
  ctx.effect(() => ctx.weftIm.provide(bot, {consumer: config.consumer, operations: {
    // The delivery id makes a retried send the same message where the platform supports it.
    send: async ({target, text, deliveryId}) => {await ctx.im.send(bot, target, String(text), deliveryId ? String(deliveryId) : undefined); return {status: 'sent'};},
    ...operations,
  }}), `dsh-im ${bot} assignment`);
  // An unclaimed event fails its delivery, so the platform or gateway delivers it again later.
  return async event => {
    if (await ctx.weftIm.deliver(bot, event) !== 'delivered') throw new Error(`IM bot ${bot}: ${config.consumer} is not receiving its events`);
  };
}
