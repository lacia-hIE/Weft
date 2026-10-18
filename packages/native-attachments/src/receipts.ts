import type {Agent} from '@deepseek-ai/dsh-agent';
import type {Session} from '@deepseek-ai/dsh-session';
import type {FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import type {FileUploadReceiptId} from '@deepseek-ai/dsh-client-file-upload/types';

interface Staged {readonly file: FileAttachmentRef; requestId?: string}
type Row = {receipt_id: string; file_json: string; request_id: string | null};
class ReceiptMap extends Map<FileUploadReceiptId, Staged> {
  constructor(private readonly storage: DurableObjectStorage, private readonly sessionId: string) {
    super();
    for (const row of storage.sql.exec<Row>('SELECT receipt_id,file_json,request_id FROM weft_upload_receipts WHERE session_id=?', sessionId).toArray()) {
      super.set(row.receipt_id as FileUploadReceiptId, this.track(row.receipt_id, {file: JSON.parse(row.file_json), ...(row.request_id === null ? {} : {requestId: row.request_id})}));
    }
  }
  private track(id: string, value: Staged): Staged {
    const record = {...value, file: Object.freeze({...value.file})};
    const binding = (requestId: unknown) => {
      if (requestId !== undefined && typeof requestId !== 'string') throw new Error('Invalid receipt binding');
      this.storage.sql.exec('UPDATE weft_upload_receipts SET request_id=? WHERE receipt_id=? AND session_id=?', requestId ?? null, id, this.sessionId);
    };
    return new Proxy(record, {
      set(target, property, next) {
        if (property !== 'requestId') throw new Error('Uploaded file reference is immutable');
        binding(next); return Reflect.set(target, property, next);
      },
      deleteProperty(target, property) {
        if (property !== 'requestId') return false;
        binding(undefined); return Reflect.deleteProperty(target, property);
      },
    });
  }
  override set(id: FileUploadReceiptId, value: Staged): this {
    this.storage.sql.exec('INSERT INTO weft_upload_receipts VALUES (?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET file_json=excluded.file_json,request_id=excluded.request_id', id, this.sessionId, JSON.stringify(value.file), value.requestId ?? null);
    return super.set(id, this.track(id, value));
  }
  override delete(id: FileUploadReceiptId): boolean {
    this.storage.sql.exec('DELETE FROM weft_upload_receipts WHERE receipt_id=? AND session_id=?', id, this.sessionId);
    return super.delete(id);
  }
  override clear(): void {for (const id of this.keys()) this.delete(id);}
}

/** Native FileUploads owns the exact Session; DO lifetime owns the durable receipts. */
export class DurableUploadRegistry {
  private readonly maps = new WeakMap<Session, ReceiptMap>();
  constructor(private readonly storage: DurableObjectStorage, private readonly sessionId: string) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_upload_receipts (receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, file_json TEXT NOT NULL, request_id TEXT)');
  }
  get(session: Session): ReceiptMap {
    if (session.id !== this.sessionId) throw new Error('Upload registry session mismatch');
    let map = this.maps.get(session);
    if (!map) {map = new ReceiptMap(this.storage, this.sessionId); this.maps.set(session, map);}
    return map;
  }
  /** Root disposal releases live objects; persisted staged input survives a cold host. */
  delete(session: Session): boolean {return this.maps.delete(session);}
  reconcile(agent: Agent): void {
    const requestId = (message: {source: {kind: string}}): string | undefined => {
      const source = message.source;
      return source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string' ? source.rpcId : undefined;
    };
    const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(requestId).filter(value => value !== undefined));
    const admitted = new Set<string>();
    for (const event of agent.session.snapshotEvents()) {
      const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : [];
      for (const message of messages) {const id = requestId(message); if (id) admitted.add(id);}
    }
    for (const [id, upload] of this.get(agent.session)) {
      if (upload.requestId === undefined || pending.has(upload.requestId)) continue;
      if (admitted.has(upload.requestId)) this.get(agent.session).delete(id);
      else delete upload.requestId;
    }
  }
}
