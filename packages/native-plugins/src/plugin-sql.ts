/** Tables the facet's host code keeps beside the plugin's own, out of the plugin's reach. */
const RESERVED = /(?:^|[^a-z0-9_])"?(?:weft_kv_|plugin_timer)/i;

/**
 * The plugin face of `weftSql`: synchronous SQL over the facet's private SQLite,
 * for state that must commit across tables. It reaches no other database.
 */
export function pluginSql(storage: DurableObjectStorage) {
  return {
    exec<Row extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): Row[] {
      if (RESERVED.test(String(query))) throw new Error('weftSql cannot address host-owned tables');
      return storage.sql.exec<Row>(String(query), ...bindings).toArray();
    },
    /** Commits when `work` returns and rolls back when it throws; a nested call is a savepoint. */
    transaction<T>(work: () => T): T {
      if (typeof work !== 'function') throw new TypeError('transaction requires a function');
      return storage.transactionSync(() => {
        const value = work();
        if (value instanceof Promise) throw new TypeError('A weftSql transaction must be synchronous');
        return value;
      });
    },
  };
}
