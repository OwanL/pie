import * as path from 'node:path';

import {
  IMAGE_PREVIEW_MIME_BY_EXTENSION,
  MAX_IMAGE_PREVIEW_BYTES,
  type ImagePreviewData,
} from '../../../lib/protocol/image-preview.js';

export interface OpenFileRequest {
  /** Exact path resolved by the renderer for the originating session. */
  path: string;
  /** Original markdown reference, retained to distinguish bare names. */
  reference?: string;
  /** Session working directory captured when the renderer handled the click. */
  workingDirectory?: string;
}

export interface FilePathResolverAdapter {
  exists(filePath: string): Promise<boolean>;
  findFiles(workingDirectory: string, basename: string): Promise<readonly string[]>;
}

export interface OpenFileAdapter extends FilePathResolverAdapter {
  chooseFile(files: readonly string[], workingDirectory: string, basename: string): Promise<string | undefined>;
  open(filePath: string): Promise<void>;
  showError(message: string): void;
}

export interface ImagePreviewAdapter extends FilePathResolverAdapter {
  /** Must return at most maxBytes + 1 bytes, even if the file changes while read. */
  readFile(filePath: string, maxBytes: number): Promise<Uint8Array>;
}

export type FilePathResolution =
  | { status: 'found'; path: string }
  | { status: 'ambiguous'; matches: readonly string[]; searchRoot: string; basename: string }
  | { status: 'missing'; searchRoot?: string };

function isBareFilename(reference: string): boolean {
  return reference.length > 0
    && reference !== '.'
    && reference !== '..'
    && !reference.includes('/')
    && !reference.includes('\\');
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function matchesBasename(filePath: string, basename: string): boolean {
  const candidate = path.basename(filePath);
  return process.platform === 'win32'
    ? candidate.toLowerCase() === basename.toLowerCase()
    : candidate === basename;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

/**
 * Resolve exactly as an open-file request does, but leave ambiguous bare names
 * explicit so previews can fail quietly instead of invoking the chooser.
 */
export async function resolveFilePathWithFallback(
  request: OpenFileRequest,
  adapter: FilePathResolverAdapter,
): Promise<FilePathResolution> {
  const reference = request.reference?.trim();
  if (await adapter.exists(request.path)) return { status: 'found', path: request.path };

  const workingDirectory = request.workingDirectory;
  const searchRoot = reference !== undefined
    && workingDirectory !== undefined
    && isBareFilename(reference)
    && path.isAbsolute(workingDirectory)
    && samePath(request.path, path.join(workingDirectory, reference))
    ? workingDirectory
    : undefined;

  if (searchRoot !== undefined && reference !== undefined) {
    const basename = path.basename(reference);
    const matches = (await adapter.findFiles(searchRoot, basename))
      .filter((candidate) => isWithinDirectory(searchRoot, candidate) && matchesBasename(candidate, basename));
    if (matches.length === 1) return { status: 'found', path: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', matches, searchRoot, basename };
  }

  return { status: 'missing', ...(searchRoot !== undefined ? { searchRoot } : {}) };
}

function hasSupportedImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/png':
      return bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      if (bytes.length < 6) return false;
      const signature = String.fromCharCode(...bytes.subarray(0, 6));
      return signature === 'GIF87a' || signature === 'GIF89a';
    }
    case 'image/webp':
      return bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
    case 'image/bmp':
      return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
    default:
      return false;
  }
}

/**
 * Read a resolved image into a bounded base64 data URL. Ambiguous, missing,
 * unsupported, oversized, unreadable, and invalid image files all fail closed.
 */
export async function readImagePreviewWithFallback(
  request: OpenFileRequest,
  adapter: ImagePreviewAdapter,
): Promise<ImagePreviewData | undefined> {
  try {
    const mimeType = IMAGE_PREVIEW_MIME_BY_EXTENSION[path.extname(request.path).toLowerCase()];
    if (!mimeType) return undefined;
    const resolution = await resolveFilePathWithFallback(request, adapter);
    if (resolution.status !== 'found') return undefined;
    const bytes = await adapter.readFile(resolution.path, MAX_IMAGE_PREVIEW_BYTES);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_PREVIEW_BYTES || !hasSupportedImageSignature(bytes, mimeType)) {
      return undefined;
    }
    return {
      mimeType,
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    };
  } catch {
    return undefined;
  }
}

/**
 * Open the exact renderer-resolved path first. Only a missing exact path paired
 * with an original bare filename may search, and that search stays rooted at
 * the renderer-captured session cwd. Ambiguous references retain the chooser.
 */
export async function openFileWithFallback(request: OpenFileRequest, adapter: OpenFileAdapter): Promise<void> {
  const reference = request.reference?.trim();
  try {
    const resolution = await resolveFilePathWithFallback(request, adapter);
    if (resolution.status === 'found') {
      await adapter.open(resolution.path);
      return;
    }
    if (resolution.status === 'ambiguous') {
      const selected = await adapter.chooseFile(resolution.matches, resolution.searchRoot, resolution.basename);
      if (selected !== undefined) await adapter.open(selected);
      return;
    }

    const name = reference || request.path;
    const scope = resolution.searchRoot !== undefined ? ` under ${resolution.searchRoot}` : '';
    adapter.showError(`Could not find file "${name}"${scope}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    adapter.showError(`Could not open file "${reference || request.path}": ${detail}`);
    throw error;
  }
}
