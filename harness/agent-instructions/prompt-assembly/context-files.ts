import * as path from 'node:path';

import type { SdkContextFile } from '../../agent-processes/lib/sdk-integration/sdk';

export interface PreparedContextFile {
  path: string;
  content: string;
  displayPath: string;
}

function looksLikeWindowsPath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
}

export function normalizeContextFilePath(filePath: string): string {
  if (typeof filePath !== 'string') return '';
  const trimmed = filePath.trim();
  if (!trimmed) {
    return '';
  }

  if (looksLikeWindowsPath(trimmed) || trimmed.startsWith('//')) {
    return path.win32.normalize(trimmed).replace(/\\/g, '/');
  }

  return path.posix.normalize(trimmed.replace(/\\/g, '/'));
}

export function contextFilePathKey(filePath: string): string {
  const normalized = normalizeContextFilePath(filePath);
  if (!normalized) {
    return '';
  }

  return looksLikeWindowsPath(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function splitPathSegments(filePath: string): string[] {
  const normalized = normalizeContextFilePath(filePath);
  if (!normalized) {
    return [];
  }

  const withoutRoot = normalized.startsWith('//')
    ? normalized.slice(2)
    : normalized.replace(/^\/+/, '');

  return withoutRoot.split('/').filter((segment) => segment.length > 0);
}

function buildDisplayPath(segments: string[], depth: number, fallbackPath: string): string {
  if (segments.length === 0) {
    return normalizeContextFilePath(fallbackPath) || fallbackPath.trim();
  }

  const start = Math.max(0, segments.length - depth);
  return segments.slice(start).join('/');
}

function assignDisplayPaths(paths: readonly string[]): Map<string, string> {
  const entries = paths.map((filePath) => {
    const segments = splitPathSegments(filePath);
    return {
      key: contextFilePathKey(filePath),
      path: normalizeContextFilePath(filePath),
      segments,
      depth: Math.min(segments.length || 1, 2),
    };
  });

  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, typeof entries>();

    for (const entry of entries) {
      const label = buildDisplayPath(entry.segments, entry.depth, entry.path);
      const group = groups.get(label) ?? [];
      group.push(entry);
      groups.set(label, group);
    }

    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }

      for (const entry of group) {
        if (entry.depth < entry.segments.length) {
          entry.depth += 1;
          changed = true;
        }
      }
    }
  }

  return new Map(entries.map((entry) => [entry.key, buildDisplayPath(entry.segments, entry.depth, entry.path)]));
}

export function prepareContextFiles(contextFiles: readonly SdkContextFile[] | undefined): PreparedContextFile[] {
  const deduped: Array<{ key: string; path: string; content: string }> = [];
  const seenKeys = new Set<string>();

  for (const contextFile of contextFiles ?? []) {
    const normalizedPath = normalizeContextFilePath(contextFile.path);
    const key = contextFilePathKey(normalizedPath);
    if (!normalizedPath || !key || seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    deduped.push({
      key,
      path: normalizedPath,
      content: contextFile.content,
    });
  }

  const displayPaths = assignDisplayPaths(deduped.map((contextFile) => contextFile.path));

  return deduped.map((contextFile) => ({
    path: contextFile.path,
    content: contextFile.content,
    displayPath: displayPaths.get(contextFile.key) ?? contextFile.path,
  }));
}
