/** The native prompt crosses a 32 MiB RPC frame; reserve room for its envelope and text. */
export const IMAGE_PROMPT_BODY_BYTES = 30 * 1024 * 1024;
export const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 20_000_000,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
});
export const NORMALIZED_IMAGE_PIXELS = 2048 * 2048;
export const NORMALIZED_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_ENCODING_QUALITIES = Object.freeze([85, 75, 60] as const);
export const IMAGE_TRANSFORM_VERSION = 'weft-cf-images-webp-v1';
