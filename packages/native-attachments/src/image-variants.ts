import {z} from 'zod';
import {AttachmentError, AttachmentId, ImageVariantId, type FileAttachmentRef, type ImageAttachmentRef, type RequestImageAttachment} from '@deepseek-ai/dsh-attachment';
import {IMAGE_LIMITS} from './image-policy.ts';

export interface ImageVariantRecord extends Omit<RequestImageAttachment, 'data'> {file: FileAttachmentRef}
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dimension = z.number().int().min(1).max(IMAGE_LIMITS.maxImageDimension);
const imageRef = z.object({attachmentId: digest, mediaType: z.literal('image/webp'), bytes: z.number().int().min(1).max(IMAGE_LIMITS.maxImageBytes), width: dimension, height: dimension, name: z.string().max(255).optional(), originalDimensions: z.object({width: dimension, height: dimension}).strict().optional()}).strict();
const schema = z.object({
  variantId: digest, attachment: imageRef,
  file: z.object({attachmentId: digest, name: z.enum(['image.webp', 'request-image.webp']), bytes: z.number().int().min(1).max(IMAGE_LIMITS.maxImageBytes)}).strict(),
  mediaType: z.literal('image/webp'), bytes: z.number().int().min(1).max(IMAGE_LIMITS.maxImageBytes),
  width: dimension, height: dimension, depth: z.literal('uchar'), space: z.literal('srgb'), hasAlpha: z.boolean(),
}).strict();

export function checkedImageReference(value: ImageAttachmentRef): void {
  if (!imageRef.safeParse(value).success) throw new AttachmentError('Invalid normalized image reference.', 'INVALID_ATTACHMENT_REF');
}
export function checkedImageVariant(value: unknown): ImageVariantRecord {
  const result = schema.safeParse(value);
  if (!result.success || result.data.bytes !== result.data.file.bytes) throw new AttachmentError('Invalid image variant record.', 'ATTACHMENT_CORRUPT');
  const row = result.data;
  const {name, originalDimensions, ...facts} = row.attachment;
  return {...row, variantId: ImageVariantId(row.variantId), attachment: {...facts, attachmentId: AttachmentId(facts.attachmentId), ...(name === undefined ? {} : {name}), ...(originalDimensions === undefined ? {} : {originalDimensions})}, file: {...row.file, attachmentId: AttachmentId(row.file.attachmentId)}};
}

/** First durable publication wins, keeping model upload identities stable across codec updates. */
export class ComputerImageVariants {
  constructor(private readonly storage: DurableObjectStorage, private readonly assertFile: (file: FileAttachmentRef) => void) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_image_variants (variant_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  }
  resolve(key: string, candidate?: ImageVariantRecord): ImageVariantRecord | null {
    if (!digest.safeParse(key).success) throw new AttachmentError('Invalid image variant identity.', 'INVALID_ATTACHMENT_REF');
    return this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{value_json: string}>('SELECT value_json FROM weft_image_variants WHERE variant_id=?', key).toArray()[0];
      if (existing) return checkedImageVariant(JSON.parse(existing.value_json));
      if (!candidate) return null;
      const value = checkedImageVariant(candidate);
      if (value.variantId !== key) throw new AttachmentError('Image variant identity mismatch.', 'INVALID_ATTACHMENT_REF');
      this.assertFile(value.file);
      this.storage.sql.exec('INSERT INTO weft_image_variants VALUES (?,?)', key, JSON.stringify(value));
      return value;
    });
  }
}
