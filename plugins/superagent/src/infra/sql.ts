/** The prepared-statement shape the Store reads and writes through, over the Host's `weftSql` service. */
export type SqlValue = string | number | null | ArrayBuffer
export type SqlRow = Record<string, SqlValue>
export interface SqlService {
  exec(query: string, ...bindings: SqlValue[]): SqlRow[]
  transaction<T>(work: () => T): T
}
export interface Statement {
  get(...bindings: SqlValue[]): SqlRow | undefined
  all(...bindings: SqlValue[]): SqlRow[]
  run(...bindings: SqlValue[]): { changes: number }
}
export class Database {
  constructor(readonly sql: SqlService) {}
  /** Runs statements without results; several may be separated by semicolons. */
  exec(query: string): void { this.sql.exec(query) }
  prepare(query: string): Statement {
    return {
      get: (...bindings) => this.sql.exec(query, ...bindings)[0],
      all: (...bindings) => this.sql.exec(query, ...bindings),
      run: (...bindings) => {
        this.sql.exec(query, ...bindings)
        return { changes: Number(this.sql.exec('SELECT changes() AS changes')[0]?.changes ?? 0) }
      },
    }
  }
}
