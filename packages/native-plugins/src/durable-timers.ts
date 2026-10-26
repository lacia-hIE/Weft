/** Callback code stays in the facet; only its schedule survives reconstruction. */
export class DurablePluginTimers {
  private readonly callbacks = new Map<number, () => unknown>();
  private sequence = 0;
  private running: Promise<void> | undefined;
  constructor(private readonly storage: DurableObjectStorage, activation: string) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS plugin_timer_epoch (id INTEGER PRIMARY KEY, activation TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS plugin_timers (id INTEGER PRIMARY KEY, delay INTEGER NOT NULL, recurring INTEGER NOT NULL, due INTEGER)');
    const previous = storage.sql.exec<{activation: string}>('SELECT activation FROM plugin_timer_epoch WHERE id=1').toArray()[0];
    if (previous?.activation !== activation) storage.transactionSync(() => {
      storage.sql.exec('DELETE FROM plugin_timers');
      storage.sql.exec('INSERT OR REPLACE INTO plugin_timer_epoch VALUES (1,?)', activation);
    });
  }
  register(callback: () => unknown, delay: number, recurring: boolean): () => void {
    if (typeof callback !== 'function' || !Number.isSafeInteger(delay) || delay < (recurring ? 60_000 : 1000)) throw new Error('Background timer requires a callback and a delay of at least 60s (interval) or 1s (timeout)');
    if (this.callbacks.size >= 32) throw new Error('A background plugin supports at most 32 timers');
    const id = ++this.sequence;
    const previous = this.storage.sql.exec<{delay: number; recurring: number}>('SELECT delay,recurring FROM plugin_timers WHERE id=?', id).toArray()[0];
    if (!previous || previous.delay !== delay || previous.recurring !== Number(recurring)) this.storage.sql.exec('INSERT OR REPLACE INTO plugin_timers VALUES (?,?,?,?)', id, delay, Number(recurring), Date.now() + delay);
    this.callbacks.set(id, callback);
    return () => {this.callbacks.delete(id); this.storage.sql.exec('DELETE FROM plugin_timers WHERE id=?', id);};
  }
  next(): number | undefined {
    return this.storage.sql.exec<{due: number | null}>('SELECT MIN(due) AS due FROM plugin_timers').one().due ?? undefined;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    const work = this.deliver(); this.running = work;
    void work.finally(() => {if (this.running === work) this.running = undefined;}).catch(() => {});
    return work;
  }
  private async deliver(): Promise<void> {
    const due = this.storage.sql.exec<{id: number; delay: number; recurring: number}>('SELECT id,delay,recurring FROM plugin_timers WHERE due<=? ORDER BY due,id LIMIT 16', Date.now()).toArray();
    for (const row of due) {
      const callback = this.callbacks.get(row.id);
      if (!callback) {this.storage.sql.exec('DELETE FROM plugin_timers WHERE id=?', row.id); continue;}
      // Leave the row due until completion. A terminated delivery is retried;
      // callers use their durable domain state/requestId for side-effect deduplication.
      try {
        await callback();
        this.storage.sql.exec('UPDATE plugin_timers SET due=? WHERE id=?', row.recurring ? Date.now() + row.delay : null, row.id);
      } catch {
        this.storage.sql.exec('UPDATE plugin_timers SET due=? WHERE id=?', Date.now() + 60_000, row.id);
      }
    }
    await this.storage.sync();
  }
}
