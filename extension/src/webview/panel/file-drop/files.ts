import type { ComposerInputDraft } from '../../../shared/protocol';

import type { ComposerTransferSource, DataTransferLike, FileLike } from './types';

function normalizeFiles(files: ArrayLike<FileLike> | undefined): FileLike[] {
  if (!files || files.length === 0) {
    return [];
  }

  const normalized: FileLike[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file) {
      normalized.push(file);
    }
  }
  return normalized;
}

export function extractTransferFiles(dataTransfer: DataTransferLike): FileLike[] {
  const files = normalizeFiles(dataTransfer.files);
  if (files.length > 0) {
    return files;
  }

  const items = dataTransfer.items;
  if (!items || items.length === 0) {
    return [];
  }

  const extracted: FileLike[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item.getAsFile !== 'function') {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      extracted.push(file);
    }
  }

  return extracted;
}

export function hasClipboardFilePayload(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  return extractTransferFiles(dataTransfer).length > 0;
}

export function resolveFilePath(file: FileLike): string | undefined {
  return 'path' in file && typeof file.path === 'string' ? file.path : undefined;
}

export function isImageMimeType(value: string | undefined): boolean {
  return typeof value === 'string' && /^image\//i.test(value.trim());
}

export function looksLikeBlobFile(file: FileLike): boolean {
  return !!(
    (typeof file.type === 'string' && file.type.trim().length > 0) ||
    typeof file.size === 'number' ||
    (typeof file.name === 'string' && file.name.trim().length > 0)
  );
}

export interface CompressedRasterImage {
  data: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
}

export type RasterImageCodec = (
  data: ArrayBuffer,
  mimeType: string,
) => Promise<CompressedRasterImage | null>;

/** Browser codec used at ingestion, before base64 inflates the payload. */
export async function compressRasterScreenshot(
  data: ArrayBuffer,
  mimeType: string,
): Promise<CompressedRasterImage | null> {
  if (mimeType === 'image/gif' || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!blob) return null;
    const outputMimeType = blob.type.trim().toLowerCase();
    if (!['image/webp', 'image/png', 'image/jpeg'].includes(outputMimeType)) return null;
    return { data: await blob.arrayBuffer(), mimeType: outputMimeType, width, height };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export async function fileToImageInput(
  file: FileLike,
  source: ComposerTransferSource,
  codec: RasterImageCodec = compressRasterScreenshot,
): Promise<Extract<ComposerInputDraft, { kind: 'imageBlob' }> | null> {
  if (!isImageMimeType(file.type) || typeof file.arrayBuffer !== 'function') {
    return null;
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    // Unreadable file (e.g. revoked blob); skip this image.
    return null;
  }

  const originalMimeType = file.type!.trim().toLowerCase();
  let data = buffer;
  let mimeType = originalMimeType;
  let name = (file.name ?? '').trim() || 'image';
  let width: number | undefined;
  let height: number | undefined;
  if (originalMimeType !== 'image/gif') {
    try {
      const compressed = await codec(buffer, originalMimeType);
      if (compressed && compressed.data.byteLength < buffer.byteLength) {
        const compressedMimeType = compressed.mimeType.trim().toLowerCase();
        const extension = compressedMimeType === 'image/webp'
          ? 'webp'
          : compressedMimeType === 'image/png'
            ? 'png'
            : compressedMimeType === 'image/jpeg'
              ? 'jpg'
              : null;
        if (extension) {
          data = compressed.data;
          mimeType = compressedMimeType;
          width = compressed.width;
          height = compressed.height;
          name = name.replace(/\.[^.]+$/, '') + `.${extension}`;
        }
      }
    } catch {
      // Codec failures must never prevent attaching the original screenshot.
    }
  }

  return {
    kind: 'imageBlob',
    mimeType,
    name,
    sizeBytes: data.byteLength,
    dataBase64: arrayBufferToBase64(data),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    source,
  };
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK_SIZE));
  }
  return btoa(binary);
}
