import {AttachmentError, longEdgeDimensions, requestImageDimensions, type ImageRequestTarget, type SaveImageAttachment} from '@deepseek-ai/dsh-attachment';
import {IMAGE_LIMITS, IMAGE_ENCODING_QUALITIES, NORMALIZED_IMAGE_BYTES, NORMALIZED_IMAGE_PIXELS} from './image-policy.ts';
import {UPLOAD_CHUNK_BYTES} from './protocol.ts';

export type ImageCodecBinding = Pick<ImagesBinding, 'info' | 'input'>;
export interface ImageFacts {width: number; height: number; hasAlpha: boolean}
export interface EncodedImage extends ImageFacts {data: Uint8Array}

/** Byte streams keep the input buffer owned by the caller, copying only one transfer chunk. */
function bytes(data: Uint8Array, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({type: 'bytes', pull(controller) {
    try {
      signal?.throwIfAborted();
      if (offset === data.byteLength) {controller.close(); return;}
      const chunk = new Uint8Array(data.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
      offset += chunk.byteLength; controller.enqueue(chunk);
    } catch (error) {controller.error(error);}
  }}, {highWaterMark: 0});
}

/** Inspect only digest-verified, previously decoded output; never admit input from its header. */
export function webpFacts(data: Uint8Array): ImageFacts {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (start: number) => String.fromCharCode(...data.subarray(start, start + 4));
  const corrupt = (): never => {throw new AttachmentError('Stored image is not a normalized WebP.', 'ATTACHMENT_CORRUPT');};
  if (data.byteLength < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== data.byteLength) return corrupt();
  let facts: ImageFacts | undefined, raster = false;
  for (let offset = 12; offset < data.byteLength;) {
    if (offset + 8 > data.byteLength) return corrupt();
    const kind = tag(offset), length = view.getUint32(offset + 4, true), start = offset + 8;
    const end = start + length;
    if (end + length % 2 > data.byteLength) return corrupt();
    if (kind === 'VP8X') {
      if (length !== 10 || data[start]! & (32 | 8 | 4 | 2)) return corrupt();
      const u24 = (at: number) => data[at]! | data[at + 1]! << 8 | data[at + 2]! << 16;
      facts = {width: u24(start + 4) + 1, height: u24(start + 7) + 1, hasAlpha: !!(data[start]! & 16)};
    } else if (kind === 'VP8L') {
      if (length < 5 || data[start] !== 47) return corrupt();
      const bits = view.getUint32(start + 1, true);
      if (bits >>> 29) return corrupt();
      facts ??= {width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1, hasAlpha: !!(bits & (1 << 28))};
      raster = true;
    } else if (kind === 'VP8 ') {
      if (length < 10 || data[start + 3] !== 157 || data[start + 4] !== 1 || data[start + 5] !== 42) return corrupt();
      facts ??= {width: view.getUint16(start + 6, true) & 16383, height: view.getUint16(start + 8, true) & 16383, hasAlpha: false};
      raster = true;
    } else if (kind !== 'ALPH') return corrupt();
    offset = end + length % 2;
  }
  if (!raster || !facts || !facts.width || !facts.height) return corrupt();
  return facts;
}

/** Actual Cloudflare raster decoding/encoding; the host never loads Sharp or a Node codec. */
export class CloudflareImageCodec {
  constructor(private readonly binding: ImageCodecBinding) {}
  private async info(data: Uint8Array, signal?: AbortSignal): Promise<{format: string; width: number; height: number}> {
    signal?.throwIfAborted();
    try {
      const info = await this.binding.info(bytes(data, signal));
      signal?.throwIfAborted();
      if (!('width' in info) || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) throw new Error('Unsupported raster');
      return info;
    } catch (error) {signal?.throwIfAborted(); throw new AttachmentError('Image bytes could not be decoded.', 'INVALID_IMAGE', {cause: error});}
  }
  private async encode(data: Uint8Array, target: {width: number; height: number}, quality: number, signal?: AbortSignal): Promise<EncodedImage> {
    signal?.throwIfAborted();
    try {
      const output = await this.binding.input(bytes(data, signal))
        .transform({width: target.width, height: target.height, fit: 'squeeze'})
        .output({format: 'image/webp', quality, anim: false});
      const reader = output.image().getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > IMAGE_LIMITS.maxImageBytes) throw new Error('Encoded image exceeds the bounded raster output');
          chunks.push(chunk.value);
        }
      } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
      const encoded = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {encoded.set(chunk, offset); offset += chunk.byteLength;}
      const facts = webpFacts(encoded);
      const decoded = await this.info(encoded, signal);
      if (decoded.format !== 'image/webp' || facts.width !== target.width || facts.height !== target.height || decoded.width !== facts.width || decoded.height !== facts.height) throw new Error('Codec output facts do not match');
      return {...facts, data: encoded};
    } catch (error) {signal?.throwIfAborted(); throw new AttachmentError('Image normalization failed.', 'ATTACHMENT_WRITE_FAILED', {cause: error});}
  }
  private async ladder(data: Uint8Array, target: ImageRequestTarget, signal?: AbortSignal): Promise<EncodedImage> {
    let smallest: EncodedImage | undefined;
    for (const quality of IMAGE_ENCODING_QUALITIES) {
      const output = await this.encode(data, target, quality, signal);
      if (output.data.byteLength <= target.maxBytes) return output;
      if (!smallest || output.data.byteLength < smallest.data.byteLength) smallest = output;
    }
    return smallest!;
  }
  async normalize(input: SaveImageAttachment): Promise<{image: EncodedImage; original: {width: number; height: number}}> {
    if (!input.data.byteLength) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE');
    if (input.data.byteLength > IMAGE_LIMITS.maxImageBytes) throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE');
    const original = await this.info(input.data);
    if (!IMAGE_LIMITS.mediaTypes.includes(original.format as SaveImageAttachment['mediaType'])) throw new AttachmentError('Unsupported raster format.', 'UNSUPPORTED_IMAGE_TYPE');
    if (original.format !== input.mediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH');
    if (original.width * original.height > IMAGE_LIMITS.maxImagePixels) throw new AttachmentError('Image exceeds the pixel limit.', 'IMAGE_TOO_MANY_PIXELS');
    if (Math.max(original.width, original.height) > IMAGE_LIMITS.maxImageDimension) throw new AttachmentError('Image exceeds the per-side limit.', 'IMAGE_DIMENSION_TOO_LARGE');
    let target = requestImageDimensions(original.width, original.height, NORMALIZED_IMAGE_PIXELS);
    if (Math.max(target.width, target.height) > IMAGE_LIMITS.maxImageDimension) target = longEdgeDimensions(target.width, target.height, IMAGE_LIMITS.maxImageDimension);
    const image = await this.ladder(input.data, {...target, maxBytes: NORMALIZED_IMAGE_BYTES});
    return {image, original};
  }
  async project(data: Uint8Array, target: ImageRequestTarget, signal?: AbortSignal): Promise<EncodedImage> {
    const source = webpFacts(data);
    if (![target.width, target.height, target.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new AttachmentError('Invalid image request target.', 'INVALID_ATTACHMENT_REF');
    const sourceEdge = Math.max(source.width, source.height);
    let edge = Math.min(sourceEdge, source.width >= source.height ? target.width : target.height);
    let dimensions = longEdgeDimensions(source.width, source.height, edge);
    if (dimensions.width > target.width || dimensions.height > target.height) {
      edge = Math.max(1, Math.floor(sourceEdge * Math.min(target.width / source.width, target.height / source.height)));
      dimensions = longEdgeDimensions(source.width, source.height, edge);
      while ((dimensions.width > target.width || dimensions.height > target.height) && edge > 1) dimensions = longEdgeDimensions(source.width, source.height, --edge);
    }
    if (edge === sourceEdge && data.byteLength <= target.maxBytes) return {...source, data};
    return this.ladder(data, {...dimensions, maxBytes: target.maxBytes}, signal);
  }
}
