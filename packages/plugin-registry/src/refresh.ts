/** Coalesce event bursts and serialize reads without retaining authority snapshots. */
export class RefreshQueue {
  private revision = 0;
  private completed = 0;
  private closed = false;
  private work: Promise<void> | undefined;
  constructor(private readonly run: (current: () => boolean) => Promise<void>, private readonly failed: (error: unknown) => void) {}
  refresh = (): void => {
    if (this.closed) return;
    this.revision++;
    this.schedule();
  };
  private schedule(): void {
    if (this.work || this.closed) return;
    this.work = Promise.resolve().then(async () => {
      while (!this.closed && this.completed !== this.revision) {
        const revision = this.completed = this.revision;
        await this.run(() => !this.closed && revision === this.revision);
      }
    }).catch(error => {if (!this.closed) this.failed(error);}).finally(() => {
      this.work = undefined;
      if (!this.closed && this.completed !== this.revision) this.schedule();
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.work ?? Promise.resolve();
  }
}
