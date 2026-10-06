/** Composer-side image validation limits. Keep these aligned with the provider
 * request boundary so users receive early feedback before dispatch. */
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_AGGREGATE_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Decoded byte length implied by an unwrapped base64 payload. */
export function decodedBase64ByteLength(value: string): number {
  const length = value.trim().length;
  if (length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(length * 3 / 4) - padding);
}

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
