import {z} from 'zod';
import {AttachmentId, ImageVariantId} from '@deepseek-ai/dsh-attachment';
import {DeepSeekFileId, DeepSeekFileScope} from '@weft/upstream/packages/llm/llm-deepseek/src/file-id.ts';
import type {DeepSeekUploadRecord} from '@weft/upstream/packages/llm/llm-deepseek/src/upload-index.ts';

const scope = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const record = z.object({scope, attachmentId: digest, variantId: digest, fileId: z.string().min(1).max(4096), bytes: time, createdAt: time, expiresAt: time}).strict();
export const modelUploadOperationSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('get'), scope, variantId: digest, now: time, margin: time}).strict(),
  z.object({type: z.literal('commit'), candidate: record, now: time, margin: time}).strict(),
  z.object({type: z.literal('remove'), scope, generations: z.array(z.object({variantId: digest, fileId: z.string().min(1).max(4096)}).strict()).max(1000)}).strict(),
  z.object({type: z.literal('clear'), scope}).strict(),
  z.object({type: z.literal('oldest'), scope, count: z.number().int().min(1).max(10_000)}).strict(),
]);
export type ModelUploadOperation = z.infer<typeof modelUploadOperationSchema>;
export function checkedUploadRecord(value: unknown): DeepSeekUploadRecord {
  const row = record.parse(value);
  return {...row, scope: DeepSeekFileScope(row.scope), attachmentId: AttachmentId(row.attachmentId), variantId: ImageVariantId(row.variantId), fileId: DeepSeekFileId(row.fileId)};
}

/** Environment-owned index; credential namespaces are hashes, never authentication headers. */
export class SqliteModelUploadIndex {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_model_uploads (scope TEXT NOT NULL, variant_id TEXT NOT NULL, file_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(scope,variant_id))');
  }
  execute(raw: ModelUploadOperation): unknown {
    const op = modelUploadOperationSchema.parse(raw);
    return this.storage.transactionSync(() => {
      if (op.type === 'get') {
        const row = this.storage.sql.exec<{value_json: string}>('SELECT value_json FROM weft_model_uploads WHERE scope=? AND variant_id=? AND expires_at-?>?', op.scope, op.variantId, op.now, op.margin).toArray()[0];
        return row ? checkedUploadRecord(JSON.parse(row.value_json)) : null;
      }
      if (op.type === 'oldest') return this.storage.sql.exec<{value_json: string}>('SELECT value_json FROM weft_model_uploads WHERE scope=? ORDER BY created_at,variant_id LIMIT ?', op.scope, op.count).toArray().map(row => checkedUploadRecord(JSON.parse(row.value_json)));
      if (op.type === 'clear') {this.storage.sql.exec('DELETE FROM weft_model_uploads WHERE scope=?', op.scope); return null;}
      if (op.type === 'remove') {
        for (const generation of op.generations) this.storage.sql.exec('DELETE FROM weft_model_uploads WHERE scope=? AND variant_id=? AND file_id=?', op.scope, generation.variantId, generation.fileId);
        return null;
      }
      const candidate = checkedUploadRecord(op.candidate);
      const row = this.storage.sql.exec<{value_json: string}>('SELECT value_json FROM weft_model_uploads WHERE scope=? AND variant_id=? AND expires_at-?>?', candidate.scope, candidate.variantId, op.now, op.margin).toArray()[0];
      if (row) return {record: checkedUploadRecord(JSON.parse(row.value_json)), accepted: false};
      this.storage.sql.exec('DELETE FROM weft_model_uploads WHERE expires_at-?<=?', op.now, op.margin);
      this.storage.sql.exec('INSERT INTO weft_model_uploads VALUES (?,?,?,?,?,?) ON CONFLICT(scope,variant_id) DO UPDATE SET file_id=excluded.file_id,created_at=excluded.created_at,expires_at=excluded.expires_at,value_json=excluded.value_json', candidate.scope, candidate.variantId, candidate.fileId, candidate.createdAt, candidate.expiresAt, JSON.stringify(candidate));
      return {record: candidate, accepted: true};
    });
  }
}
