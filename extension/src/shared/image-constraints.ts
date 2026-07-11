/** Maximum allowed size for a single image attachment (10 MiB). */
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;

/** Maximum aggregate raw image bytes in one composer/message request. */
export const MAX_AGGREGATE_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Decoded byte length implied by an unwrapped base64 payload. Invalid input is
 * handled by the downstream decoder; this is a conservative sizing guard. */
export function decodedBase64ByteLength(value: string): number {
  const length = value.trim().length;
  if (length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(length * 3 / 4) - padding);
}

/** MIME types accepted for image attachments. */
export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
