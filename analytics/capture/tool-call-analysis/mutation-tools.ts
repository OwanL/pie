import type { ToolCall } from '../../../harness/agent-processes/lib/rpc/message-contract.js';
import { normalizeToolCallName } from './summary';
import { isRecord } from '../../../lib/validation/type-guards';
import type { FileExtensionOperation } from './mutation-types';

export const DIRECT_FILE_PATH_KEYS = [
  'filePath',
  'fileUri',
  'sessionPath',
  'oldPath',
  'newPath',
  'requestedPath',
  'targetPath',
  'sourcePath',
  'destinationPath',
  'old_path',
  'new_path',
  'requested_path',
  'target_path',
  'source_path',
  'destination_path',
] as const;

export const GENERIC_PATH_KEYS = [
  'path',
] as const;

export const WRITE_CONTENT_KEYS = [
  'content',
  'contents',
  'text',
  'body',
  'value',
] as const;

export const TEXT_CONTAINER_KEYS = [
  'content',
  'contents',
  'text',
  'output',
  'result',
  'body',
  'value',
  'markdown',
] as const;

export function looksLikeReadTool(toolName: string): boolean {
  return /(?:^|[_-])read(?:$|[_-])/.test(toolName);
}

export function looksLikeCreateTool(toolName: string): boolean {
  return /(?:^|[_-])(create|write)(?:$|[_-])/.test(toolName);
}

export function looksLikeEditTool(toolName: string): boolean {
  return /(?:^|[_-])(edit|update|replace|patch)(?:$|[_-])/.test(toolName) || toolName === 'apply_patch';
}

export function looksLikeDeleteTool(toolName: string): boolean {
  return /(?:^|[_-])(delete|remove|unlink)(?:$|[_-])/.test(toolName);
}

export function looksLikeRenameTool(toolName: string): boolean {
  return /(?:^|[_-])(rename|move)(?:$|[_-])/.test(toolName);
}

export function getFileExtensionOperation(toolName: string): FileExtensionOperation | null {
  const normalizedName = normalizeToolCallName(toolName);
  if (looksLikeReadTool(normalizedName)) {
    return 'read';
  }
  if (looksLikeCreateTool(normalizedName)) {
    return 'write';
  }
  if (looksLikeEditTool(normalizedName)) {
    return 'edit';
  }
  return null;
}

export function hasPathLikeValue(value: unknown): boolean {
  return (typeof value === 'string' && value.trim().length > 0)
    || (Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0));
}

export function hasToolCallPathInput(toolCall: ToolCall): boolean {
  if (!isRecord(toolCall.input)) {
    return false;
  }

  for (const key of DIRECT_FILE_PATH_KEYS) {
    if (hasPathLikeValue(toolCall.input[key])) {
      return true;
    }
  }

  for (const key of GENERIC_PATH_KEYS) {
    if (hasPathLikeValue(toolCall.input[key])) {
      return true;
    }
  }

  return false;
}

export function extractFirstPathFromInput(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  for (const key of DIRECT_FILE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  for (const key of GENERIC_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

export function extractExtensionFromPath(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const basename = separatorIndex >= 0 ? filePath.slice(separatorIndex + 1) : filePath;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return '(none)';
  }
  return basename.slice(dotIndex).toLowerCase();
}

/**
 * Deterministic 32-bit FNV-1a hash of a file path, base36-encoded. Used as a stable, non-reversible
 * key for per-file edit tracking (file-churn signal) so raw file paths are never persisted. Collisions
 * are negligible for path strings. Dependency-free so this stays browser-safe in `shared/`.
 */
export function hashPath(filePath: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
