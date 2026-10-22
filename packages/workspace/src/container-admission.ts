/** Persistent admission fence shared by commands, process reconnects and file sync. */
export class ContainerAdmission {
  private value: {epoch: number; stopping: number};
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS weft_container_admission (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, stopping INTEGER NOT NULL)');
    sql.exec('INSERT OR IGNORE INTO weft_container_admission VALUES (1,0,0)');
    this.value = sql.exec<{epoch: number; stopping: number}>('SELECT epoch,stopping FROM weft_container_admission WHERE id=1').one();
  }
  get epoch(): number {return this.value.epoch;}
  get stopping(): boolean {return this.value.stopping === 1;}
  assert(epoch = this.epoch): void {
    if (this.stopping) throw new Error('The workspace container is stopping. Try the command again after it stops.');
    if (epoch !== this.epoch) throw new Error('The workspace container was stopped; this process connection has ended. Commands were not replayed.');
  }
  begin(): number {
    if (!this.stopping) {
      this.value = {epoch: this.epoch + 1, stopping: 1};
      this.sql.exec('UPDATE weft_container_admission SET epoch=?,stopping=1 WHERE id=1', this.epoch);
    }
    return this.epoch;
  }
  finish(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.sql.exec('UPDATE weft_container_admission SET stopping=0 WHERE id=1');
    this.value.stopping = 0;
  }
}
