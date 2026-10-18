import {createHash} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import AttachmentStore, {AttachmentError, type AttachmentErrorCode, type FileAttachmentRef, type SaveFileAttachment, type SaveFileStreamAttachment, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment, type ImageRequestTarget, type RequestImageAttachment, type AttachmentAdmissionPart, type AdmittedPromptContentPart, type ImageAttachmentLimits} from '@deepseek-ai/dsh-attachment';
import type {WorkspaceScope} from '../../workspace/src/protocol.ts';
import {ATTACHMENT_ROOT, UPLOAD_CHUNK_BYTES} from './protocol.ts';
import type {ImageCodecBinding} from './image-codec.ts';
import {ComputerImageAttachments} from './image-store.ts';
import {IMAGE_LIMITS} from './image-policy.ts';
import {checkedImageVariant, type ImageVariantRecord} from './image-variants.ts';
import {storedFilePath} from '../../../.generated/official-file-reference.ts';

export interface AttachmentTransport {
  uploadAttachment(scope: WorkspaceScope, sessionId: string, name: string | undefined, body: ReadableStream<Uint8Array>): Promise<Response>;
  readAttachment(scope: WorkspaceScope, ref: FileAttachmentRef): Promise<Response>;
  imageVariant(scope: WorkspaceScope, key: string, record?: ImageVariantRecord): Promise<Response>;
}
interface Config {scope: WorkspaceScope; sessionId: string; transport: AttachmentTransport; images?: ImageCodecBinding}
export const fileOnlyImageLimits = Object.freeze({maxImageBytes: 20 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 50 * 1024 * 1024, maxImagePixels: 40_000_000, maxImageDimension: 16_384, mediaTypes: []});

/** Native AttachmentStore backed by immutable Computer files, with chunk backpressure. */
export class ComputerAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits;
  private readonly images: ComputerImageAttachments;
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx);
    this.imageLimits = config.images ? IMAGE_LIMITS : fileOnlyImageLimits;
    this.images = new ComputerImageAttachments(this, config.images, async (key, record) => {
      const response = await this.checked(await config.transport.imageVariant(config.scope, key, record));
      const {value} = await response.json() as {value: unknown};
      return value === null ? null : checkedImageVariant(value);
    });
  }
  override async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]> {
    const images = content.filter(part => part.type === 'image');
    if (images.length > this.imageLimits.maxImagesPerMessage) throw new AttachmentError('Too many images.', 'TOO_MANY_IMAGES');
    let total = 0;
    for (const image of images) {
      if (!this.imageLimits.mediaTypes.includes(image.mediaType)) throw new AttachmentError('Image input is not configured for this type.', 'UNSUPPORTED_IMAGE_TYPE');
      const bytes = Math.floor(image.data.length / 4) * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
      if (bytes > this.imageLimits.maxImageBytes) throw new AttachmentError('Image exceeds its byte limit.', 'IMAGE_TOO_LARGE');
      total += bytes;
    }
    if (total > this.imageLimits.maxMessageImageBytes) throw new AttachmentError('Image batch exceeds its byte limit.', 'IMAGES_TOO_LARGE');
    return super.admitPromptContent(content);
  }
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
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('Stored file stream could not be verified.', 'ATTACHMENT_READ_FAILED', {cause: error});
    } finally {signal?.removeEventListener('abort', onAbort); await reader.cancel().catch(() => {}); reader.releaseLock();}
  }
  override validateImage(input: SaveImageAttachment): Promise<void> {return this.images.validate(input);}
  override saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {return this.images.save(input);}
  override readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {return this.images.read(ref, signal);}
  override imageHostPath(ref: ImageAttachmentRef): string {return this.images.hostPath(ref);}
  override readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment> {return this.images.request(ref, target, signal);}
}
