/** Conservative formats that render as raster images in the bundled Chromium.
 * SVG is intentionally excluded: preview payloads are data URLs, never markup.
 */
export const IMAGE_PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
});

/** Keep hover previews within the existing 10 MiB image-ingress precedent. */
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PREVIEW_PATH_BYTES = 4 * 1024;
export const MAX_IMAGE_PREVIEW_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_PREVIEW_BYTES / 3) * 4 + 64;

export interface ImagePreviewData {
  mimeType: string;
  dataUrl: string;
}

const SUPPORTED_PREVIEW_MIME_TYPES = new Set(Object.values(IMAGE_PREVIEW_MIME_BY_EXTENSION));

/** Defend the imperative response boundary even when a host adapter is faulty. */
export function isBoundedImagePreviewData(value: unknown): value is ImagePreviewData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('mimeType') || !keys.includes('dataUrl')) return false;
  if (typeof data.mimeType !== 'string' || !SUPPORTED_PREVIEW_MIME_TYPES.has(data.mimeType)) return false;
  if (typeof data.dataUrl !== 'string' || data.dataUrl.length > MAX_IMAGE_PREVIEW_DATA_URL_CHARS) return false;
  return data.dataUrl.startsWith(`data:${data.mimeType};base64,`);
}
