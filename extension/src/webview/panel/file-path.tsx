/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import {
  formatPathWithParentDepth,
  normalizePathSeparators,
  trimTrailingPathSeparators,
  normalizeComparablePath,
  relativePathFromBase,
  truncatePathText,
} from '../../shared/path-utils.js';

export { formatPathWithParentDepth, normalizePathSeparators, trimTrailingPathSeparators, normalizeComparablePath, relativePathFromBase, truncatePathText };

function looksLikeFileLeaf(value: string): boolean {
  const leaf = value.trim();
  if (!leaf || leaf === '.' || leaf === '..') {
    return false;
  }

  // Treat dotted leaves (settings-menu.tsx, README.md, .gitignore) and
  // conventional extensionless project files (Makefile, Dockerfile, LICENSE)
  // as files. Bare directory names should stay subtle so a trailing folder is
  // not presented with the same emphasis as an actual file target.
  const extensionlessFileNames = new Set(['makefile', 'dockerfile', 'license', 'copying', 'notice']);
  if (extensionlessFileNames.has(leaf.toLowerCase())) return true;

  return leaf.startsWith('.') && leaf.length > 1
    ? !leaf.slice(1).includes('/') && !leaf.slice(1).includes('\\')
    : /\.[A-Za-z0-9_-]{1,12}$/.test(leaf);
}

export function splitSummaryPath(summary: string): { pathSection: string | null; fileSection: string | null } {
  const lastSeparatorIndex = Math.max(summary.lastIndexOf('/'), summary.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= summary.length - 1) {
    return looksLikeFileLeaf(summary)
      ? { pathSection: null, fileSection: summary }
      : { pathSection: summary, fileSection: null };
  }

  const leaf = summary.slice(lastSeparatorIndex + 1);
  if (!looksLikeFileLeaf(leaf)) {
    return { pathSection: summary, fileSection: null };
  }

  return {
    pathSection: summary.slice(0, lastSeparatorIndex + 1),
    fileSection: leaf,
  };
}

// ── Shared rendering ─────────────────────────────────────────────────────

export interface ClickablePathButtonProps {
  path: string;
  displayText: string;
  parentDepth?: number;
  onOpenFile?: (path: string) => void;
}

export function ClickablePathButton({ path, displayText, parentDepth, onOpenFile }: ClickablePathButtonProps): JSX.Element {
  const visibleText = parentDepth !== undefined ? formatPathWithParentDepth(displayText, parentDepth) : displayText;
  const { pathSection, fileSection } = splitSummaryPath(visibleText);
  if (!fileSection) {
    return (
      <span class="transcript-header-path-preview" title={path}>
        <span class="transcript-header-summary-subtle transcript-header-path-prefix">
          <span class="[direction:ltr] [unicode-bidi:isolate]">{pathSection ?? displayText}</span>
        </span>
      </span>
    );
  }
  return (
    <span class="transcript-header-path-preview" title={path}>
      {pathSection ? (
        <span class="transcript-header-summary-subtle transcript-header-path-prefix">
          <span class="[direction:ltr] [unicode-bidi:isolate]">{pathSection}</span>
        </span>
      ) : null}
      {onOpenFile ? (
        <button
          type="button"
          class="transcript-header-summary-link group"
          title={path}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(path);
          }}
        >
          <span class="transcript-header-summary-emphasis transcript-header-path-target">{fileSection}</span>
        </button>
      ) : (
        <span class="transcript-header-summary-emphasis transcript-header-path-target">{fileSection}</span>
      )}
    </span>
  );
}
