import {createHash} from 'node:crypto';
import {AttachmentError, ImageVariantId, type AttachmentStore, type FileAttachmentRef, type ImageAttachmentRef, type ImageRequestTarget, type RequestImageAttachment, type SaveImageAttachment, type StoredImageAttachment} from '@deepseek-ai/dsh-attachment';
import {CompressionLimiter} from '@weft/upstream/packages/attachment/attachment-local/src/compression-limiter.ts';
import {imageDisplayName} from '../../../.generated/official-image-helpers.ts';
import {CloudflareImageCodec, webpFacts, type ImageCodecBinding} from './image-codec.ts';
import {checkedImageReference, checkedImageVariant, type ImageVariantRecord} from './image-variants.ts';
import {IMAGE_LIMITS, IMAGE_TRANSFORM_VERSION, IMAGE_ENCODING_QUALITIES} from './image-policy.ts';

interface ImageFiles extends Pick<AttachmentStore, 'saveFile' | 'saveFileStream' | 'readFileStream'> {fileHostPath(ref: FileAttachmentRef): string}

export class ComputerImageAttachments {
  private readonly limiter = new CompressionLimiter(1);
  private readonly codec: CloudflareImageCodec | undefined;
  constructor(private readonly files: ImageFiles, images: ImageCodecBinding | undefined, private readonly variant: (key: string, value?: ImageVariantRecord) => Promise<ImageVariantRecord | null>) {
    this.codec = images ? new CloudflareImageCodec(images) : undefined;
  }
  private available(): CloudflareImageCodec {
    if (!this.codec) throw new AttachmentError('Image admission is not configured.', 'UNSUPPORTED_IMAGE_TYPE');
    return this.codec;
  }
  private file(ref: ImageAttachmentRef): FileAttachmentRef {checkedImageReference(ref); return {attachmentId: ref.attachmentId, name: 'image.webp', bytes: ref.bytes};}
  hostPath(ref: ImageAttachmentRef): string {return this.files.fileHostPath(this.file(ref));}
  validate(input: SaveImageAttachment): Promise<void> {return this.limiter.run(async () => {await this.available().normalize(input);});}
  save(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return this.limiter.run(async () => {
      const {image, original} = await this.available().normalize(input);
      const file = await this.files.saveFile({data: image.data, name: 'image.webp'});
      const name = imageDisplayName(input.name);
      const reduced = image.width !== original.width || image.height !== original.height;
      return {attachmentId: file.attachmentId, bytes: file.bytes, width: image.width, height: image.height, mediaType: 'image/webp', ...(name === undefined ? {} : {name}), ...(reduced ? {originalDimensions: {width: original.width, height: original.height}} : {})};
    });
  }
  private async readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<Uint8Array> {
    if (ref.bytes > IMAGE_LIMITS.maxImageBytes) throw new AttachmentError('Stored image exceeds its bound.', 'ATTACHMENT_CORRUPT');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of this.files.readFileStream(ref, signal)) {length += chunk.byteLength; if (length > ref.bytes) throw new AttachmentError('Stored image length mismatch.', 'ATTACHMENT_CORRUPT'); chunks.push(chunk);}
    if (length !== ref.bytes) throw new AttachmentError('Stored image length mismatch.', 'ATTACHMENT_CORRUPT');
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {data.set(chunk, offset); offset += chunk.byteLength;}
    return data;
  }
  private async stored(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    const data = await this.readFile(this.file(ref), signal);
    const facts = webpFacts(data);
    if (facts.width !== ref.width || facts.height !== ref.height) throw new AttachmentError('Stored image dimensions mismatch.', 'ATTACHMENT_CORRUPT');
    return {ref, data};
  }
  read(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {return this.limiter.run(() => this.stored(ref, signal));}
  request(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment> {
    return this.limiter.run(async () => {
      signal?.throwIfAborted();
      if (![target.width, target.height, target.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new AttachmentError('Invalid image request target.', 'INVALID_ATTACHMENT_REF');
      const source = await this.stored(ref, signal);
      const variantId = ImageVariantId('sha256:' + createHash('sha256').update(JSON.stringify({version: IMAGE_TRANSFORM_VERSION, source: ref.attachmentId, width: target.width, height: target.height, maxBytes: target.maxBytes, qualities: IMAGE_ENCODING_QUALITIES, format: 'image/webp', anim: false})).digest('hex'));
      let record = await this.variant(variantId);
      if (!record) {
        const projected = await this.available().project(source.data, target, signal);
        signal?.throwIfAborted();
        const file = await this.files.saveFileStream({name: 'request-image.webp', data: (async function* () {yield projected.data;})(), ...(signal ? {signal} : {})});
        const candidate: ImageVariantRecord = {variantId, attachment: ref, file, mediaType: 'image/webp', bytes: file.bytes, width: projected.width, height: projected.height, depth: 'uchar', space: 'srgb', hasAlpha: projected.hasAlpha};
        record = await this.variant(variantId, candidate);
        if (!record) throw new AttachmentError('Image variant was not published.', 'ATTACHMENT_WRITE_FAILED');
      }
      record = checkedImageVariant(record);
      if (record.variantId !== variantId || record.attachment.attachmentId !== ref.attachmentId || record.width > target.width || record.height > target.height) throw new AttachmentError('Image variant does not match its request.', 'ATTACHMENT_CORRUPT');
      const data = await this.readFile(record.file, signal);
      const facts = webpFacts(data);
      if (facts.width !== record.width || facts.height !== record.height || facts.hasAlpha !== record.hasAlpha) throw new AttachmentError('Image variant facts mismatch.', 'ATTACHMENT_CORRUPT');
      signal?.throwIfAborted();
      return {variantId, attachment: ref, mediaType: record.mediaType, bytes: data.byteLength, width: facts.width, height: facts.height, depth: 'uchar', space: 'srgb', hasAlpha: facts.hasAlpha, data};
    });
  }
}
