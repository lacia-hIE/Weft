import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import type { SessionPromptRequest, SessionUpdateQueueRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { openHarnessSession, type RuntimeOptions, type HarnessSessionHost } from '../../../packages/harness-runtime/src/runtime.ts';
import { turnFailure, type TurnFailure } from '../../../packages/model-provider/src/index.ts';

interface Owner {
  waitUntil(promise: Promise<unknown>): void;
  changed(): Promise<void>;
  failed(failure: TurnFailure): Promise<void>;
}

/** A DO owns this native Agent root across turns, including its plugin fibers. */
export class NativeSessionHost {
  private runtime: HarnessSessionHost | undefined;
  private admission = Promise.resolve();
  private publication = Promise.resolve();
  private driver: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private constructor(private readonly options: RuntimeOptions, private readonly turnTimeoutMs: number, private readonly owner: Owner) {}

  static async open(options: RuntimeOptions, turnTimeoutMs: number, owner: Owner): Promise<NativeSessionHost> {
    const host = new NativeSessionHost(options, turnTimeoutMs, owner);
    host.runtime = await openHarnessSession({...options, onEvent: (event, session) => {
      options.onEvent?.(event, session);
      if (event.type === 'turn/start') {
        host.clearTimer();
        host.timer = setTimeout(() => {
          host.runtime?.agent.cancel({kind: 'hook', reason: 'turn-deadline'}, {keepInbox: true});
          owner.waitUntil(owner.failed({code: 'TURN_TIMEOUT', message: 'Turn deadline exceeded', status: 504}));
        }, turnTimeoutMs);
      } else if (event.type === 'turn/end') host.clearTimer();
      host.changed();
    }});
    host.runtime.ctx.on('agent/status', () => {host.changed(); host.watch();});
    host.runtime.ctx.on('agent/error', ({error}) => {owner.waitUntil(owner.failed(turnFailure(error)));});
    host.runtime.ctx.sessionProjections.onChanged(() => {host.changed();});
    host.changed();
    // Cold recovery can release persisted queued input after factory setup.
    host.watch();
    return host;
  }

  get ctx() { return this.runtime!.ctx; }
  get agent() { return this.runtime!.agent; }
  private clearTimer(): void {if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;}
  private changed(): void {
    if (!this.runtime || this.closed) return;
    this.publication = this.publication.catch(() => {}).then(async () => {
      if (this.closed) return;
      await this.ctx.get('sessionPersistence')?.flush();
      await this.owner.changed();
    });
    this.owner.waitUntil(this.publication);
  }
  private watch(): void {
    if (this.driver || this.closed || this.agent.status !== 'running') return;
    const drive = async () => {
      do {await this.agent.whenIdle(); await this.ctx.get('sessionPersistence')?.flush();}
      while (!this.closed && this.agent.status === 'running');
      this.changed();
    };
    const pending = drive().finally(() => {
      if (this.driver === pending) this.driver = undefined;
      if (!this.closed && this.agent.status === 'running') this.watch();
    });
    this.driver = pending;
    this.owner.waitUntil(pending);
  }
  async whenIdle(): Promise<void> {
    await this.agent.whenIdle();
    await this.ctx.get('sessionPersistence')?.flush();
    await this.publication;
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admission.then(operation);
    this.admission = result.then(() => {}, () => {});
    return result;
  }
  private seen(requestId: string): boolean {
    return this.agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' ? event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === requestId
      : event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId));
  }
  async prompt(request: SessionPromptRequest): Promise<void> {
    await this.serialized(async () => {
      if (this.seen(request.requestId)) return;
      if (request.content.some(block => block.type !== 'text')) throw new RemoteError('session/attachment-invalid', 'Attachment admission is not connected yet', {reason: 'attachment-unavailable'});
      const content = request.content.flatMap(block => block.type === 'text' ? [block] : []);
      if (!content.some(block => block.text.trim().length)) throw new RemoteError('gateway/bad-request', 'Prompt content is empty', {});
      const timeZone = request.clientTimeZone === undefined ? undefined : canonicalClientTimeZone(request.clientTimeZone);
      if (request.clientTimeZone !== undefined && timeZone === undefined) throw new RemoteError('session/invalid-time-zone', 'Invalid client time zone', {value: request.clientTimeZone});
      if (this.agent.inbox.nextTurn.length + this.agent.inbox.nextStep.length >= 32) throw new RemoteError('session/agent-busy', 'Session inbox is full', {reason: 'queue-full'});
      await this.options.beforeAssembly?.();
      this.agent.ctx.fiber.assertActive();
      const message = createUserMessage({content, source: {kind: 'user', rpcId: request.requestId, ...(timeZone === undefined ? {} : {clientTimeZone: timeZone})}});
      if (request.mode === 'steer') this.agent.steer(message);
      else this.agent.followup(message);
      this.watch();
      // Native inbox splices are durable admission, even before the message is
      // consumed by a running turn. No model await is held by the prompt RPC.
      await this.ctx.get('sessionPersistence')?.flush();
      this.changed();
    });
  }
  async updateQueue(request: SessionUpdateQueueRequest): Promise<void> {
    await this.serialized(async () => {
      const turn = this.agent.inbox.nextTurn.find(message => message.id === request.itemId);
      const step = this.agent.inbox.nextStep.find(message => message.id === request.itemId);
      const message = turn ?? step;
      if (!message) throw new RemoteError('session/queue-item-not-found', 'Queued item is no longer pending', {itemId: request.itemId});
      switch (request.action.kind) {
        case 'edit': {
          if (request.action.content.some(block => block.type !== 'text')) throw new RemoteError('session/attachment-invalid', 'Queue edits accept text only', {reason: 'QUEUE_EDIT_NON_TEXT'});
          if (!request.action.content.some(block => block.type === 'text' && block.text.trim().length)) throw new RemoteError('gateway/bad-request', 'Queue edit content is empty', {});
          this.agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({...message, content: [...request.action.content]})); break;
        }
        case 'remove': this.agent.inbox.remove(request.itemId); break;
        case 'steer': {
          if (!turn || this.agent.status !== 'running') throw new RemoteError('session/steer-unavailable', 'Current turn no longer accepts steering', {itemId: request.itemId});
          this.agent.inbox.remove(request.itemId); this.agent.steer(message); this.watch(); break;
        }
      }
      await this.ctx.get('sessionPersistence')?.flush();
      this.changed();
    });
  }
  cancel(): void {this.agent.cancel({kind: 'user'}, {keepInbox: true}); this.watch();}
  async deliver(message: UserMessage, wakeup: boolean): Promise<void> {
    await this.serialized(async () => {
      this.agent.send(message, 'next-step', wakeup);
      if (wakeup) this.watch();
      await this.ctx.get('sessionPersistence')?.flush();
      this.changed();
    });
  }
  async dispose(): Promise<void> {
    this.closed = true; this.clearTimer();
    await this.runtime?.dispose();
    await this.publication.catch(() => {});
  }
}
