import {DeepSeekFileStore, type DeepSeekFileConnection} from '@weft/upstream/packages/llm/llm-deepseek/src/file-store.ts';
import {DeepSeekUploadIndex, deepSeekFileScope, type DeepSeekUploadRecord, type UploadIndexCommit} from '@weft/upstream/packages/llm/llm-deepseek/src/upload-index.ts';
import {DeepSeekFilesClient, DeepSeekFilesError} from '@weft/upstream/packages/llm/llm-deepseek/src/files-api.ts';
import {messagesApiRoot} from '@weft/upstream/packages/llm/llm-deepseek/src/messages-api.ts';
import {checkedUploadRecord, type ModelUploadOperation} from './files-protocol.ts';
import {fetchProvider} from './fetch.ts';

/** Replace every filesystem operation on the native index with addressed EnvironmentDO RPC. */
export class EnvironmentUploadIndex extends DeepSeekUploadIndex {
  constructor(private readonly transport: (op: ModelUploadOperation) => Promise<Response>) {
    // The inherited path is inert: all four native index methods are overridden.
    super('sqlite:weft_model_uploads');
  }
  private async call<T>(op: ModelUploadOperation): Promise<T> {
    const response = await this.transport(op);
    if (!response.ok) throw new Error('Environment model upload index unavailable');
    return (await response.json() as {value: T}).value;
  }
  override async get(...args: Parameters<DeepSeekUploadIndex['get']>): Promise<DeepSeekUploadRecord | undefined> {
    const [scope, variantId, now, margin] = args;
    const value = await this.call<unknown>({type: 'get', scope, variantId, now, margin});
    return value === null ? undefined : checkedUploadRecord(value);
  }
  override async commit(...args: Parameters<DeepSeekUploadIndex['commit']>): Promise<UploadIndexCommit> {
    const [candidate, now, margin] = args;
    const value = await this.call<{record: unknown; accepted: boolean}>({type: 'commit', candidate, now, margin});
    return {record: checkedUploadRecord(value.record), accepted: value.accepted};
  }
  override async remove(...args: Parameters<DeepSeekUploadIndex['remove']>): Promise<void> {
    const [scope, generations] = args;
    await this.call({type: 'remove', scope, generations: [...generations]});
  }
  override async clear(...args: Parameters<DeepSeekUploadIndex['clear']>): Promise<void> {await this.call({type: 'clear', scope: args[0]});}
  async owned(scope: DeepSeekUploadRecord['scope'], count: number): Promise<DeepSeekUploadRecord[]> {
    const records = await this.call<unknown[]>({type: 'oldest', scope, count});
    return records.map(checkedUploadRecord);
  }
}

/** Native upload/reuse/retry logic, with cleanup confined to this environment's recorded IDs. */
export class EnvironmentDeepSeekFiles extends DeepSeekFileStore {
  constructor(private readonly ownedIndex: EnvironmentUploadIndex) {super({index: ownedIndex, fetch: fetchProvider});}
  private providerScope(connection: DeepSeekFileConnection) {
    return deepSeekFileScope(messagesApiRoot(connection.baseURL), JSON.stringify(Object.entries(connection.headers).sort(([left], [right]) => left.localeCompare(right))));
  }
  private async cleanup(connection: DeepSeekFileConnection, count: number, signal?: AbortSignal): Promise<{removed: number; deleted: number}> {
    const scope = this.providerScope(connection);
    const records = await this.ownedIndex.owned(scope, Math.min(count, 10_000));
    const client = new DeepSeekFilesClient({baseURL: connection.baseURL, headers: connection.headers, fetch: fetchProvider});
    let deleted = 0;
    for (const record of records) {
      signal?.throwIfAborted();
      try {await client.delete(record.fileId, signal); deleted++;}
      catch (error) {if (!(error instanceof DeepSeekFilesError) || error.failure.status !== 404) throw error;}
      await this.ownedIndex.remove(scope, [{variantId: record.variantId, fileId: record.fileId}]);
    }
    return {removed: records.length, deleted};
  }
  override async reclaimOldestOwned(connection: DeepSeekFileConnection, count: number, signal?: AbortSignal): Promise<number> {
    return (await this.cleanup(connection, count, signal)).deleted;
  }
  override async releaseAll(connection: DeepSeekFileConnection, signal?: AbortSignal): Promise<number> {
    let total = 0;
    for (;;) {const result = await this.cleanup(connection, 1000, signal); total += result.deleted; if (result.removed < 1000) break;}
    return total;
  }
}
