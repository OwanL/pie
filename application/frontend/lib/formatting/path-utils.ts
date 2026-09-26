// Shared path utilities used by both the webview panel (file-path.tsx) and
// tool-call-summary.ts. Pure string/regex/math operations — no node:path, no
// DOM — so the module is safe to import from both host and webview contexts.

export const PATH_SUMMARY_MAX_LENGTH = 240;

export function truncateString(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3).trimEnd()}...`
    : text;
}

// ── Path normalization ───────────────────────────────────────────────────

export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

export function trimTrailingPathSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value;
  }
  return value.replace(/\/+$/, '');
}

export function normalizeComparablePath(value: string): string {
  const normalized = trimTrailingPathSeparators(normalizePathSeparators(value));
  if (/^[A-Za-z]:/.test(normalized)) {
    return `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  if (normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function relativePathFromBase(targetPath: string, basePath: string): string | null {
  const comparableTarget = normalizeComparablePath(targetPath);
  const comparableBase = normalizeComparablePath(basePath);
  if (!comparableTarget || !comparableBase || comparableTarget === comparableBase) {
    return null;
  }

  const prefix = comparableBase.endsWith('/') ? comparableBase : `${comparableBase}/`;
  if (!comparableTarget.startsWith(prefix)) {
    return null;
  }

  const normalizedTarget = trimTrailingPathSeparators(normalizePathSeparators(targetPath));
  const normalizedBase = trimTrailingPathSeparators(normalizePathSeparators(basePath));
  return normalizedTarget.slice(normalizedBase.length + 1) || null;
}

function truncatePathParentFromLeft(parentPath: string, maxLength: number): string {
  if (parentPath.length <= maxLength) {
    return parentPath;
  }

  if (maxLength <= 0) {
    return '';
  }

  const sliceStart = Math.max(0, parentPath.length - maxLength);
  const slicedParentPath = parentPath.slice(sliceStart);
  const nextSeparatorOffset = slicedParentPath.search(/[\\/]/);
  if (nextSeparatorOffset < 0) {
    return slicedParentPath.replace(/^[\\/]+/, '');
  }

  const pathSuffix = slicedParentPath.slice(nextSeparatorOffset + 1);
  return pathSuffix || slicedParentPath.replace(/^[\\/]+/, '');
}

/**
 * Render a path with at most `parentDepth` parent directory segments before
 * the filename. `parentDepth = 0` shows only the filename; `parentDepth = 1`
 * shows the immediate parent + filename; larger values include progressively
 * more ancestors. The full original path is preserved by callers for tooltips
 * and open/copy actions; this only produces the displayed label.
 *
 * Separators are normalized to '/' for display. Paths without a separator
 * (already a bare filename) pass through unchanged.
 */
export function formatPathWithParentDepth(path: string, parentDepth: number): string {
  if (!path || parentDepth < 0) return path;

  const normalized = normalizePathSeparators(path);
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return path;

  const fileName = parts[parts.length - 1];
  const parentParts = parts.slice(0, -1);

  if (parentDepth === 0 || parentParts.length === 0) {
    return fileName;
  }

  const start = Math.max(0, parentParts.length - parentDepth);
  const selectedParents = parentParts.slice(start);
  return `${selectedParents.join('/')}/${fileName}`;
}

export function truncatePathText(value: string): string {
  if (value.length <= PATH_SUMMARY_MAX_LENGTH) {
    return value;
  }

  const lastSeparatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= value.length - 1) {
    return truncateString(value, PATH_SUMMARY_MAX_LENGTH);
  }

  const separator = value[lastSeparatorIndex] === '\\' ? '\\' : '/';
  const fileSection = value.slice(lastSeparatorIndex + 1);
  if (!fileSection) {
    return truncateString(value, PATH_SUMMARY_MAX_LENGTH);
  }

  const parentPath = value.slice(0, lastSeparatorIndex).replace(/[\\/]+$/, '');
  const fullParentBudget = PATH_SUMMARY_MAX_LENGTH - fileSection.length - separator.length;
  if (parentPath.length <= fullParentBudget) {
    return `${parentPath}${separator}${fileSection}`;
  }

  const clippedPathMarker = `...${separator}`;
  const truncatedParentBudget = PATH_SUMMARY_MAX_LENGTH - fileSection.length - clippedPathMarker.length - separator.length;
  if (truncatedParentBudget <= 0) {
    return truncateString(fileSection, PATH_SUMMARY_MAX_LENGTH);
  }

  const truncatedParentPath = truncatePathParentFromLeft(parentPath, truncatedParentBudget);
  return truncatedParentPath
    ? `${clippedPathMarker}${truncatedParentPath}${separator}${fileSection}`
    : `${clippedPathMarker}${fileSection}`;
}