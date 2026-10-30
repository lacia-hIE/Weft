import {ConnectionGateway, type GatewayScope} from '../../packages/connection-gateway/src/index.ts';

/** The real durable gateway, with deterministic provider I/O instead of external mail credentials. */
export class MailGatewayFixture extends ConnectionGateway {
  async pollAgain() {await this.alarm();}
  async closedReplyError(key: string, input: unknown) {
    try {await this.mailCall(key, 'mailReply', input); return '';}
    catch (error) {return error instanceof Error ? error.message : String(error);}
  }
  protected capacity() {return 10;}
  protected environment(_scope: GatewayScope) {
    return {nativeConnectionLease: async (_scope: unknown, _receipt: unknown, ids: string[]) => ids,
      nativeConnectionDeliver: async (_scope: unknown, _receipt: unknown, _id: string, events: unknown[]) => {
        const deliveries = await this.ctx.storage.get<unknown[]>('received') ?? [];
        deliveries.push(...events); await this.ctx.storage.put('received', deliveries); return 'ok' as const;
      }};
  }
  protected override mailTransport() {
    return {check: async () => {}, attachment: async () => ({base64: 'AA=='}),
      poll: async (_spec: unknown, cursor: string) => ({cursor: String(Number(cursor || 0) + 1), messages: cursor ? [{messageId: '<new@example.com>'}] : []}),
      reply: async (_spec: unknown, _input: unknown, reserve?: () => void) => {
        const fail = await this.ctx.storage.get<string>('failure');
        if (fail === 'connect') throw new Error('Authentication refused');
        reserve?.();
        const sent = await this.ctx.storage.get<number>('sent') ?? 0; await this.ctx.storage.put('sent', sent + 1);
        if (fail === 'ack') throw new Error('DATA acknowledgement lost');
        return {messageId: '<reply-' + sent + '@example.com>'};
      }};
  }
  async fixture(failure?: string) {
    if (failure !== undefined) await this.ctx.storage.put('failure', failure);
    return {sent: await this.ctx.storage.get<number>('sent') ?? 0, received: await this.ctx.storage.get<unknown[]>('received') ?? [],
      rows: this.ctx.storage.sql.exec<{cursor: string; spec: string}>('SELECT cursor,spec FROM connections').toArray()};
  }
}
export default {fetch() {return new Response('mail gateway fixture');}};
