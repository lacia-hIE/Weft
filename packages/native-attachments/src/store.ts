import {createHash} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import AttachmentStore, {AttachmentError, type AttachmentErrorCode, type FileAttachmentRef, type SaveFileAttachment, type SaveFileStreamAttachment, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment} from '@deepseek-ai/dsh-attachment';
import type {WorkspaceScope} from '../../workspace/src/protocol.ts';
import {ATTACHMENT_ROOT, UPLOAD_CHUNK_BYTES} from './protocol.ts';
import {storedFilePath} from '../../../.generated/official-file-reference.ts';

export interface AttachmentTransport {
  uploadAttachment(scope: WorkspaceScope, sessionId: string, name: string | undefined, body: ReadableStream<Uint8Array>): Promise<Response>;
  readAttachment(scope: WorkspaceScope, ref: FileAttachmentRef): Promise<Response>;
}
interface Config {scope: WorkspaceScope; sessionId: string; transport: AttachmentTransport}
export const fileOnlyImageLimits = Object.freeze({maxImageBytes: 20 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 50 * 1024 * 1024, maxImagePixels: 40_000_000, maxImageDimension: 16_384, mediaTypes: []});

/** Native AttachmentStore backed by immutable Computer files, with chunk backpressure. */
export class ComputerAttachmentStore extends AttachmentStore {
  readonly imageLimits = fileOnlyImageLimits;
  constructor(ctx: Context, private readonly config: Config) {super(ctx);}
  private async checked(response: Response): Promise<Response> {
    if (!response.ok) {
      const failure = await response.json() as {error: string; code: AttachmentErrorCode};
      throw new AttachmentError(failure.error, failure.code);
    }
    return response;
  }
  override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return this.saveFileStream({data: (async function* () {yield input.data;})(), ...(input.name === undefined ? {} : {name: input.name})});
  }
  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    input.signal?.throwIfAborted();
    const iterator = input.data[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    let bytes = 0, finished = false, chunk: Uint8Array | undefined, offset = 0;
    let sourceFailure: unknown;
    const abort = new AbortController();
    let controller: Pick<ReadableByteStreamController, 'error'>;
    const onAbort = () => {abort.abort(input.signal?.reason); controller.error(input.signal?.reason);};
    input.signal?.addEventListener('abort', onAbort, {once: true});
    const body = new ReadableStream<Uint8Array>({
      type: 'bytes',
      start(value) {controller = value;},
      async pull(controller) {
        try {
          abort.signal.throwIfAborted();
          while (!chunk || offset === chunk.byteLength) {
            const next = await iterator.next();
            if (next.done) {finished = true; controller.close(); return;}
            chunk = next.value; offset = 0;
            if (chunk.byteLength) break;
          }
          const data = new Uint8Array(chunk.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
          offset += data.byteLength; bytes += data.byteLength; hash.update(data);
          controller.enqueue(data);
        } catch (error) {sourceFailure = error; controller.error(error);}
      },
      async cancel(reason) {abort.abort(reason); await iterator.return?.();},
    }, {highWaterMark: 0});
    try {
      input.signal?.throwIfAborted();
      const response = await this.config.transport.uploadAttachment(this.config.scope, this.config.sessionId, input.name, body);
      if (sourceFailure) throw sourceFailure;
      const {value} = await (await this.checked(response)).json() as {value: FileAttachmentRef};
      if (!finished || value.bytes !== bytes || value.attachmentId !== 'sha256:' + hash.digest('hex')) throw new AttachmentError('Uploaded file failed integrity verification.', 'ATTACHMENT_CORRUPT');
      input.signal?.throwIfAborted();
      return value;
    } catch (error) {input.signal?.throwIfAborted(); throw sourceFailure ?? error;}
    finally {
      input.signal?.removeEventListener('abort', onAbort);
      abort.abort();
      if (!finished) {if (!body.locked) await body.cancel().catch(() => {}); await iterator.return?.();}
    }
  }
  override fileHostPath(ref: FileAttachmentRef): string {return storedFilePath(ATTACHMENT_ROOT, ref);}
  override async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    this.fileHostPath(ref); signal?.throwIfAborted();
    const response = await this.checked(await this.config.transport.readAttachment(this.config.scope, ref));
    if (!response.body) throw new AttachmentError('Stored file has no body.', 'ATTACHMENT_READ_FAILED');
    const reader = response.body.getReader();
    const onAbort = () => {void reader.cancel(signal?.reason).catch(() => {});};
    signal?.addEventListener('abort', onAbort, {once: true});
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const {done, value} = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        hash.update(value); bytes += value.byteLength;
        if (bytes > ref.bytes) throw new AttachmentError('Stored file exceeds declared size.', 'ATTACHMENT_CORRUPT');
        yield value;
      }
      if (bytes !== ref.bytes || 'sha256:' + hash.digest('hex') !== ref.attachmentId) throw new AttachmentError('Stored file failed integrity verification.', 'ATTACHMENT_CORRUPT');
    } finally {signal?.removeEventListener('abort', onAbort); await reader.cancel().catch(() => {}); reader.releaseLock();}
  }
  override async validateImage(_input: SaveImageAttachment): Promise<void> {throw new AttachmentError('Image admission is not configured for this deployment.', 'UNSUPPORTED_IMAGE_TYPE');}
  override async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {throw new AttachmentError('Image admission is not configured for this deployment.', 'UNSUPPORTED_IMAGE_TYPE');}
  override async readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {throw new AttachmentError('Image storage is not configured for this deployment.', 'ATTACHMENT_NOT_FOUND');}
}
