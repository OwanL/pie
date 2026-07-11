import type { ComposerInputDraft } from '../../../shared/protocol';

import {
  extractTransferFiles,
  fileToImageInput,
  hasClipboardFilePayload,
  isImageMimeType,
  looksLikeBlobFile,
  resolveFilePath,
  type RasterImageCodec,
} from './files';
import {
  basename,
  canAcceptPathDrop,
  extractDroppedPaths,
  extractStructuredDroppedPaths,
  normalizeAbsolutePath,
} from './paths';
import type {
  ComposerTransferExtraction,
  ComposerTransferSource,
  DataTransferLike,
  DataTransferItemLike,
  FileLike,
} from './types';

export type {
  ComposerTransferExtraction,
  ComposerTransferSource,
  DataTransferLike,
  DataTransferItemLike,
  FileLike,
};

export { canAcceptPathDrop, extractDroppedPaths, hasClipboardFilePayload };

export function canAcceptComposerTransfer(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (canAcceptPathDrop(dataTransfer)) {
    return true;
  }

  const files = extractTransferFiles(dataTransfer);
  return files.some((file) => isImageMimeType(file.type));
}

export async function extractComposerInputs(
  dataTransfer: DataTransferLike | null | undefined,
  source: ComposerTransferSource,
  imageCodec?: RasterImageCodec,
): Promise<ComposerTransferExtraction> {
  if (!dataTransfer) {
    return { inputs: [], unsupportedInputs: [], rejectedFiles: [] };
  }

  const inputs: ComposerInputDraft[] = [];
  const unsupportedInputs: Array<Extract<ComposerInputDraft, { kind: 'fileBlob' }>> = [];
  const rejectedFiles: string[] = [];
  const seenFilesystemPaths = new Set<string>();

  for (const path of extractStructuredDroppedPaths(dataTransfer)) {
    if (seenFilesystemPaths.has(path)) {
      continue;
    }
    seenFilesystemPaths.add(path);
    inputs.push({
      kind: 'filesystemPathRef',
      path,
      name: basename(path),
      source: source === 'drop' ? 'drop' : 'picker',
    });
  }

  const files = extractTransferFiles(dataTransfer);
  for (const file of files) {
    const imageInput = await fileToImageInput(file, source, imageCodec);
    if (imageInput) {
      inputs.push(imageInput);
      continue;
    }

    const path = normalizeAbsolutePath(resolveFilePath(file) ?? '');
    if (path) {
      if (seenFilesystemPaths.has(path)) {
        continue;
      }
      seenFilesystemPaths.add(path);
      inputs.push({
        kind: 'filesystemPathRef',
        path,
        name: basename(path),
        source: source === 'drop' ? 'drop' : 'picker',
      });
      continue;
    }

    if (looksLikeBlobFile(file)) {
      const name = (file.name ?? '').trim() || 'unnamed file';
      rejectedFiles.push(name);
      unsupportedInputs.push({
        kind: 'fileBlob',
        mimeType: (file.type ?? '').trim() || 'application/octet-stream',
        name,
        sizeBytes: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0,
        dataBase64: '',
        source,
      });
    }
  }

  return { inputs, unsupportedInputs, rejectedFiles };
}

export function formatComposerTransferError(rejectedFiles: string[]): string | null {
  if (rejectedFiles.length === 0) {
    return null;
  }

  if (rejectedFiles.length === 1) {
    return `Cannot attach ${rejectedFiles[0]}: arbitrary file blobs are not supported yet. Attach a filesystem path instead.`;
  }

  return `Cannot attach ${rejectedFiles.length} files: arbitrary file blobs are not supported yet. Attach filesystem paths instead.`;
}
