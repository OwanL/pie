import { extractTransferFiles } from './files';
import type { DataTransferLike, FileLike } from './types';
import { toErrorMessage } from '../../../shared/error-message';
import { webviewLog } from '../utils/log';

const FILES_TYPE = 'Files';
const CODE_FILES_TYPE = 'CodeFiles';
const CODE_EDITORS_TYPE = 'CodeEditors';
const RESOURCE_URLS_TYPE = 'ResourceURLs';
const URI_LIST_TYPE = 'text/uri-list';
const INTERNAL_URI_LIST_TYPE = 'application/vnd.code.uri-list';
const PLAIN_TEXT_TYPE = 'text/plain';

export function canAcceptPathDrop(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;

  // Hover-time checks must stay type-only because getData is not reliable until drop.
  // Be permissive for candidate path formats and decide what is really usable on drop.
  const types = normalizeTypes(dataTransfer.types);
  return (
    types.has(FILES_TYPE.toLowerCase()) ||
    types.has(CODE_FILES_TYPE.toLowerCase()) ||
    types.has(CODE_EDITORS_TYPE.toLowerCase()) ||
    types.has(RESOURCE_URLS_TYPE.toLowerCase()) ||
    types.has(URI_LIST_TYPE.toLowerCase()) ||
    types.has(PLAIN_TEXT_TYPE.toLowerCase()) ||
    types.has(INTERNAL_URI_LIST_TYPE.toLowerCase()) ||
    (dataTransfer.files?.length ?? 0) > 0
  );
}

export function extractDroppedPaths(dataTransfer: DataTransferLike | null | undefined): string[] {
  if (!dataTransfer) return [];

  const structuredPaths = extractStructuredDroppedPaths(dataTransfer);
  if (structuredPaths.length > 0) {
    return structuredPaths;
  }

  return extractPathsFromFiles(extractTransferFiles(dataTransfer));
}

export function extractStructuredDroppedPaths(dataTransfer: DataTransferLike): string[] {
  const codeFilePaths = extractPathsFromCodeFiles(safeGetData(dataTransfer, CODE_FILES_TYPE));
  if (codeFilePaths.length > 0) {
    return codeFilePaths;
  }

  const resourcePaths = extractPathsFromResourceUrls(safeGetData(dataTransfer, RESOURCE_URLS_TYPE));
  if (resourcePaths.length > 0) {
    return resourcePaths;
  }

  const editorPaths = extractPathsFromCodeEditors(safeGetData(dataTransfer, CODE_EDITORS_TYPE));
  if (editorPaths.length > 0) {
    return editorPaths;
  }

  const uriListPaths = extractPathsFromUriPayload(
    safeGetData(dataTransfer, INTERNAL_URI_LIST_TYPE) || safeGetData(dataTransfer, URI_LIST_TYPE),
  );
  if (uriListPaths.length > 0) {
    return uriListPaths;
  }

  const plainTextPaths = extractPathsFromPlainText(safeGetData(dataTransfer, PLAIN_TEXT_TYPE));
  if (plainTextPaths.length > 0) {
    return plainTextPaths;
  }

  return [];
}

export function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

export function normalizeAbsolutePath(value: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return value.replace(/\//g, '\\');
  }

  if (/^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return value.replace(/\//g, '\\');
  }

  if (value.startsWith('/')) {
    return value;
  }

  return null;
}

function normalizeTypes(types: DataTransferLike['types']): Set<string> {
  const normalized = new Set<string>();
  if (!types) return normalized;

  for (let index = 0; index < types.length; index += 1) {
    const value = types[index];
    if (typeof value === 'string' && value.length > 0) {
      normalized.add(value.toLowerCase());
    }
  }

  return normalized;
}

function safeGetData(dataTransfer: DataTransferLike, format: string): string {
  try {
    return dataTransfer.getData(format) ?? '';
  } catch {
    // getData can throw for unsupported/unavailable formats at hover time; ignore.
    return '';
  }
}

function extractPathsFromUriPayload(value: string): string[] {
  if (!value.trim()) return [];

  const jsonUris = parseJsonStringArray(value)
    .map(fileUriToFsPath)
    .filter((path): path is string => !!path);
  if (jsonUris.length > 0) {
    return dedupe(jsonUris);
  }

  const paths: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const path = fileUriToFsPath(line);
    if (path) {
      paths.push(path);
    }
  }

  return dedupe(paths);
}

function extractPathsFromCodeFiles(value: string): string[] {
  const parsed = parseJsonStringArray(value).map(normalizeAbsolutePath).filter((path): path is string => !!path);
  return dedupe(parsed);
}

function extractPathsFromResourceUrls(value: string): string[] {
  const parsed = parseJsonStringArray(value).map(fileUriToFsPath).filter((path): path is string => !!path);
  return dedupe(parsed);
}

function extractPathsFromCodeEditors(value: string): string[] {
  if (!value.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    // Non-fatal: a malformed CodeEditors drop payload just yields no paths.
    webviewLog('warn', 'file-drop', 'CodeEditors drop payload JSON parse failed', { error: toErrorMessage(err) });
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  const paths = parsed
    .map((entry) => extractPathFromEditorEntry(entry))
    .filter((path): path is string => !!path);
  return dedupe(paths);
}

function extractPathsFromPlainText(value: string): string[] {
  if (!value.trim()) return [];

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const paths: string[] = [];
  for (const line of lines) {
    const uriPath = fileUriToFsPath(line);
    if (uriPath) {
      paths.push(uriPath);
      continue;
    }

    const normalizedPath = normalizeAbsolutePath(line);
    if (!normalizedPath) {
      return [];
    }
    paths.push(normalizedPath);
  }

  return dedupe(paths);
}

function extractPathsFromFiles(files: ArrayLike<FileLike> | undefined): string[] {
  if (!files || files.length === 0) return [];

  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as (FileLike & { path?: string }) | undefined;
    const path = normalizeAbsolutePath(file?.path ?? '');
    if (path) {
      paths.push(path);
    }
  }

  return dedupe(paths);
}

function extractPathFromEditorEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const resource = (entry as Record<string, unknown>)['resource'];
  if (typeof resource === 'string') {
    return fileUriToFsPath(resource);
  }

  if (!resource || typeof resource !== 'object') {
    return null;
  }

  const scheme = (resource as Record<string, unknown>)['scheme'];
  const path = (resource as Record<string, unknown>)['path'];
  const authority = (resource as Record<string, unknown>)['authority'];
  if (scheme !== 'file' || typeof path !== 'string') {
    return null;
  }

  if (typeof authority === 'string' && authority.length > 0 && authority !== 'localhost') {
    return `\\\\${authority}${path.replace(/\//g, '\\')}`;
  }

  if (/^\/[A-Za-z]:/.test(path)) {
    return path.slice(1).replace(/\//g, '\\');
  }

  return path;
}

function parseJsonStringArray(value: string): string[] {
  if (!value.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    // Non-fatal: a malformed drop payload just yields no string entries.
    webviewLog('warn', 'file-drop', 'drop payload JSON parse failed', { error: toErrorMessage(err) });
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function fileUriToFsPath(rawValue: string): string | null {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    // Not a valid URL (e.g. a bare path); not a file:// URI we can map.
    return null;
  }

  if (url.protocol !== 'file:') {
    return null;
  }

  const host = decodeURIComponent(url.hostname);
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }

  if (host && host !== 'localhost') {
    return `\\\\${host}${pathname.replace(/\//g, '\\')}`;
  }

  return pathname;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
