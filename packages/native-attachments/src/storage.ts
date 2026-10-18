import {createHash, randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {z} from 'zod';
import type {Workspace} from '@cloudflare/computer';
import {AttachmentError, AttachmentId, type FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {fileLeafName, storedFilePath} from '../../../.generated/official-file-reference.ts';

import {ATTACHMENT_ROOT, UPLOAD_CHUNK_BYTES} from './protocol.ts';
export {ATTACHMENT_ROOT, ATTACHMENT_PRIVATE_ROOT, UPLOAD_CHUNK_BYTES} from './protocol.ts';
const STAGING = '/.weft-uploads';
const refSchema = z.object({attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/), name: z.string().min(1).max(255), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const attachmentOperationSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('begin'), sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().max(4096).optional()}).strict(),
  z.object({type: z.literal('append'), sessionId: z.string(), uploadId: z.uuid(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), data: z.instanceof(Uint8Array).refine(value => value.byteLength <= UPLOAD_CHUNK_BYTES)}).strict(),
  z.object({type: z.literal('commit'), sessionId: z.string(), uploadId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({type: z.literal('abort'), sessionId: z.string(), uploadId: z.uuid()}).strict(),
  z.object({type: z.literal('read'), ref: refSchema, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict(),
]);
export type AttachmentOperation = z.infer<typeof attachmentOperationSchema>;
type Row = {id: string; session_id: string; name: string; bytes: number; updated_at: number};
type Provider = ReturnType<Workspace['provider']>;

/** Physical Computer files; private staging and atomic immutable publication. */
export class ComputerAttachmentFiles {
  constructor(private readonly storage: DurableObjectStorage, private readonly fs: Provider, private readonly publish: (path: string) => void) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_attachment_uploads (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  }
  private row(id: string, sessionId: string): Row {
    const row = this.storage.sql.exec<Row>('SELECT * FROM weft_attachment_uploads WHERE id=? AND session_id=?', id, sessionId).toArray()[0];
    if (!row) throw new AttachmentError('Upload is missing or belongs to another session.', 'ATTACHMENT_NOT_FOUND');
    return row;
  }
  private exists(path: string): boolean {try {this.fs.statSync(path); return true;} catch (error) {if ((error as {code?: string}).code === 'ENOENT') return false; throw error;}}
  private hash(path: string): string {
    const hash = createHash('sha256');
    for (let offset = 0;; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = this.fs.readRangeSync(path, offset, UPLOAD_CHUNK_BYTES);
      hash.update(chunk);
      if (chunk.byteLength < UPLOAD_CHUNK_BYTES) return hash.digest('hex');
    }
  }
  execute(operation: AttachmentOperation): unknown {
    return this.storage.transactionSync(() => {
      if (operation.type === 'begin') {
        for (const row of this.storage.sql.exec<Row>('SELECT * FROM weft_attachment_uploads WHERE updated_at<?', Date.now() - 86_400_000).toArray()) {
          if (this.exists(STAGING+'/'+row.id)) this.fs.unlinkSync(STAGING+'/'+row.id);
          this.storage.sql.exec('DELETE FROM weft_attachment_uploads WHERE id=?', row.id);
        }
        if (this.storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_attachment_uploads').one().count >= 16) throw new AttachmentError('Too many unfinished uploads in this workspace.', 'ATTACHMENT_WRITE_FAILED');
        this.fs.mkdirSync(STAGING, {recursive: true});
        const id = randomUUID();
        this.fs.createFileSync(STAGING+'/'+id);
        this.storage.sql.exec('INSERT INTO weft_attachment_uploads VALUES (?,?,?,?,?)', id, operation.sessionId, fileLeafName(operation.name), 0, Date.now());
        return {uploadId: id};
      }
      if (operation.type === 'read') {
        const ref: FileAttachmentRef = {...operation.ref, attachmentId: AttachmentId(operation.ref.attachmentId)};
        const path = storedFilePath(ATTACHMENT_ROOT, ref);
        if (!this.exists(path)) throw new AttachmentError('File attachment is missing.', 'ATTACHMENT_NOT_FOUND');
        if (this.fs.statSync(path).size !== ref.bytes) throw new AttachmentError('File attachment size does not match.', 'ATTACHMENT_CORRUPT');
        return this.fs.readRangeSync(path, operation.offset, UPLOAD_CHUNK_BYTES);
      }
      const row = this.row(operation.uploadId, operation.sessionId);
      const stage = STAGING+'/'+row.id;
      if (operation.type === 'append') {
        if (operation.offset !== row.bytes || row.bytes + operation.data.byteLength > Number.MAX_SAFE_INTEGER) throw new AttachmentError('Upload chunk is out of order.', 'ATTACHMENT_WRITE_FAILED');
        this.fs.writeRangeSync(stage, operation.data, operation.offset);
        this.storage.sql.exec('UPDATE weft_attachment_uploads SET bytes=bytes+?,updated_at=? WHERE id=?', operation.data.byteLength, Date.now(), row.id);
        return null;
      }
      if (operation.type === 'abort') {
        this.fs.unlinkSync(stage);
        this.storage.sql.exec('DELETE FROM weft_attachment_uploads WHERE id=?', row.id);
        return null;
      }
      const sha256 = this.hash(stage);
      if (sha256 !== operation.sha256 || this.fs.statSync(stage).size !== row.bytes) throw new AttachmentError('Uploaded bytes failed integrity verification.', 'ATTACHMENT_CORRUPT');
      const ref = {attachmentId: AttachmentId('sha256:'+sha256), name: row.name, bytes: row.bytes};
      const object = `${ATTACHMENT_ROOT}/file-objects/${sha256.slice(0, 2)}/${sha256}`;
      const alias = storedFilePath(ATTACHMENT_ROOT, ref);
      this.fs.mkdirSync(posix.dirname(object), {recursive: true});
      this.fs.mkdirSync(posix.dirname(alias), {recursive: true});
      if (this.exists(object)) {
        if (this.fs.statSync(object).size !== row.bytes || this.hash(object) !== sha256) throw new AttachmentError('Existing attachment failed integrity verification.', 'ATTACHMENT_CORRUPT');
        this.fs.unlinkSync(stage);
      } else this.fs.renameSync(stage, object);
      if (!this.exists(alias)) this.fs.linkSync(object, alias);
      else if (this.fs.statSync(alias).size !== row.bytes || this.hash(alias) !== sha256) throw new AttachmentError('Attachment alias failed integrity verification.', 'ATTACHMENT_CORRUPT');
      this.publish(alias);
      this.storage.sql.exec('DELETE FROM weft_attachment_uploads WHERE id=?', row.id);
      return ref;
    });
  }
}
