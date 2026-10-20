/**
 * Client uplink for one Remote stream carried over separate ordered requests.
 * Input may arrive before the stream opens; an unclaimed queue expires.
 */
export class UplinkQueue implements AsyncIterable<unknown> {
  private readonly items: unknown[] = [];
  private ended = false;
  private wake: (() => void) | undefined;
  private readonly expiry: ReturnType<typeof setTimeout>;
  constructor(onExpire: () => void, private readonly limit = 256) {
    this.expiry = setTimeout(onExpire, 120_000);
  }
  claim(): void { clearTimeout(this.expiry); }
  push(items: readonly unknown[], end: boolean): void {
    if (this.ended) return;
    if (this.items.length + items.length > this.limit) throw new Error('Remote stream uplink is over its pending limit');
    this.items.push(...items);
    if (end) this.ended = true;
    this.wake?.();
  }
  end(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.items.length) yield this.items.shift();
      if (this.ended) return;
      await new Promise<void>(resolve => {this.wake = resolve;});
      this.wake = undefined;
    }
  }
}
