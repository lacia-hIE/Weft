import {snapshotJsonValue} from '@deepseek-ai/dsh-util-values';

/** Largest IM event, operation argument or result that crosses a facet boundary. */
const IM_WIRE_BYTES = 1_048_576;
const BOT = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATION = /^[a-z][a-zA-Z]{0,31}$/;

function wire(value: unknown): unknown {
  const detached = snapshotJsonValue(value);
  if (detached === undefined) throw new TypeError('IM values must be lossless JSON');
  if (new TextEncoder().encode(JSON.stringify(detached)).byteLength > IM_WIRE_BYTES) throw new RangeError('IM value exceeds 1 MiB');
  return detached;
}
function bot(value: unknown): string {
  if (typeof value !== 'string' || !BOT.test(value)) throw new TypeError('IM bot keys are 1-64 lowercase letters, digits or underscores');
  return value;
}

/** One bot a package holds the connection of, and the package the bot is assigned to. */
export interface ImProvider {
  /** Package name of the consumer; only that package may receive the bot's events or run its operations. */
  consumer: string;
  /** The bot's channel, such as `feishu`, and its display name, as the consumer lists them; the channel defaults to the key's part before `_`. */
  kind?: string;
  name?: string;
  /** Operations the consumer may run, such as `send` or `read`; each takes and returns JSON. */
  operations: Record<string, (argument: unknown) => unknown>;
}
/** A bot as its consumer lists it. */
export interface ImBot {bot: string; kind: string; name?: string}
/** A package's handler for the events of bots assigned to it. */
export interface ImConsumer {message(bot: string, event: unknown): unknown}
/** Host-side routes; the Host adds the calling package's name, which a facet cannot choose. */
export interface ImHost {
  imDeliver(consumer: string, bot: string, event: unknown): Promise<'delivered' | 'unclaimed'>;
  imCall(bot: string, operation: string, argument: unknown): Promise<unknown>;
  imConsumers(): Promise<string[]>;
  imBots(): Promise<ImBot[]>;
}

/**
 * The plugin face of `weftIm`, which joins the package that holds an IM bot's
 * connection with the package the bot is assigned to. The holder `provide`s
 * the bot with its consumer's name and `deliver`s each inbound event; the
 * consumer registers one handler with `consume` and runs the bot's operations
 * with `call`. Registrations last for the activation; the Host keeps none.
 */
export class WorkerIm {
  private readonly providers = new Map<string, ImProvider>();
  private consumer: ImConsumer | undefined;
  constructor(private readonly host: ImHost) {}
  readonly service = {
    /** @returns a disposer that withdraws the bot. */
    provide: (key: string, provider: ImProvider) => {
      const name = bot(key);
      if (typeof provider?.consumer !== 'string' || !provider.consumer) throw new TypeError('An IM bot names the package it is assigned to');
      if (this.providers.has(name)) throw new Error(`IM bot ${name} is provided twice`);
      this.providers.set(name, provider);
      return () => {if (this.providers.get(name) === provider) this.providers.delete(name);};
    },
    /** @returns whether the bot's consumer is active and took the event. */
    deliver: (key: string, event: unknown) => {
      const provider = this.providers.get(bot(key));
      if (!provider) throw new Error(`IM bot ${key} is not provided by this package`);
      return this.host.imDeliver(provider.consumer, key, wire(event));
    },
    /** @returns a disposer that stops receiving events. */
    consume: (handler: ImConsumer) => {
      if (typeof handler?.message !== 'function') throw new TypeError('consume requires a message handler');
      if (this.consumer) throw new Error('This package already consumes IM events');
      this.consumer = handler;
      return () => {if (this.consumer === handler) this.consumer = undefined;};
    },
    /**
     * Run an operation of a bot assigned to this package.
     * @throws Error when no active package provides the bot to this package.
     */
    call: (key: string, operation: string, argument: unknown = null) => {
      if (typeof operation !== 'string' || !OPERATION.test(operation)) throw new TypeError('Invalid IM operation name');
      return this.host.imCall(bot(key), operation, wire(argument));
    },
    /** @returns the names of active packages that consume IM events. */
    consumers: () => this.host.imConsumers(),
    /** @returns the bots active packages provide to this package. */
    bots: () => this.host.imBots(),
  };
  /** Host → consumer: hand one event of an assigned bot to the handler. */
  async receive(key: string, event: unknown): Promise<'delivered' | 'unclaimed'> {
    if (!this.consumer) return 'unclaimed';
    await this.consumer.message(bot(key), wire(event));
    return 'delivered';
  }
  /** Host → holder: run an operation for `caller` when this package provides the bot to it. */
  async answer(caller: string, key: string, operation: string, argument: unknown): Promise<{handled: false} | {handled: true; value: unknown}> {
    const provider = this.providers.get(bot(key));
    if (!provider || provider.consumer !== caller) return {handled: false};
    const run = Object.hasOwn(provider.operations, operation) ? provider.operations[operation] : undefined;
    if (typeof run !== 'function') throw new Error(`IM bot ${key} has no ${operation} operation`);
    return {handled: true, value: wire(await run(wire(argument)) ?? null)};
  }
  /** Host → holder: the bots this package provides to `caller`. */
  assigned(caller: string): ImBot[] {
    return [...this.providers].filter(([, provider]) => provider.consumer === caller)
      .map(([bot, provider]) => ({bot, kind: typeof provider.kind === 'string' && provider.kind ? provider.kind : bot.split('_')[0]!, ...typeof provider.name === 'string' && provider.name ? {name: provider.name.slice(0, 100)} : {}}));
  }
  consuming(): boolean {return this.consumer !== undefined;}
}
