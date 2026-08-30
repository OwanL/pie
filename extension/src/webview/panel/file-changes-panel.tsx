/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_CHAT_PREFS, type FileChangeEntry, type ChatPrefs } from '../../shared/protocol';
import { cx } from './utils/cx';
import { ResizeHandle } from './components/resize-handle';
import { useResizableWidth } from './components/use-resizable-width';
import { handleContextMenuKeyRequest } from './components/context-menu-key';
import { LineStats, FileName } from './file-changes-row';
import { getContextMenuTrigger } from './components/useMenuTriggerAria';
import { FileChangeContextMenu } from './file-changes-context-menu';
import type { FileChangeContextMenuState } from './file-changes-context-menu';
import { computeDiffTotals, computeKindStats, KIND_ORDER, KIND_LABEL } from './file-changes-stats';
import { formatPathWithParentDepth } from './file-path';

// Re-export the public surface previously bundled in this module so existing
// import paths (`./file-changes-panel`) keep resolving unchanged.
export { computeDiffTotals, computeKindStats } from './file-changes-stats';
export { FileChangeContextMenu } from './file-changes-context-menu';
export type { FileChangeContextMenuState } from './file-changes-context-menu';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  expanded: boolean;
  onToggleExpanded: (expanded: boolean) => void;
  onOpenDiff: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
  /** Paths of changed files marked read for the active session (host state). */
  readFilePaths: string[];
  /** Mark a changed file read/unread (right-click action). */
  onSetFileRead: (filePath: string, read: boolean) => void;
  prefs?: ChatPrefs;
}

// Hover-intent / dismiss delays for the peek overlay (STATE_CONTRACT
// § Webview-Local State — peek/hover overlays). Tunable; see
// the changed-files-rail design (decision D9).
const PEEK_OPEN_DELAY = 160;
const PEEK_CLOSE_DELAY = 120;

export function FileChangesPanel({
  fileChanges,
  expanded,
  onToggleExpanded,
  onOpenDiff,
  onOpenInEditor,
  onRevertFile,
  readFilePaths,
  onSetFileRead,
  prefs = DEFAULT_CHAT_PREFS,
}: FileChangesPanelProps) {
  const pinned = expanded;
  const [hasNewChanges, setHasNewChanges] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const prevCountRef = useRef(fileChanges.length);
  const railRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover capability — touch devices get tap-to-peek instead of hover-peek
  // (changed-files-rail design, decision D8). SSR-safe (preact-render-to-string has no
  // window); the webview always has a window.
  const [canHover] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(hover: hover)').matches;
  });

  const totals = useMemo(() => computeDiffTotals(fileChanges), [fileChanges]);

  const kindStats = useMemo(() => computeKindStats(fileChanges), [fileChanges]);

  // Read-state membership for the active session (host-owned
  // `ViewState.readFilePaths`). Read files sort to the bottom of the list and
  // render darkened; the collapsed sliver darkens them in place.
  const readSet = useMemo(() => new Set(readFilePaths), [readFilePaths]);

  // Split the list into unread (top) and read (bottom) groups, preserving the
  // derivation order within each. Read files are demoted below the unread
  // group, separated by a "Reviewed" divider when both groups are non-empty.
  const { unreadChanges, readChanges } = useMemo(() => {
    const unread: FileChangeEntry[] = [];
    const read: FileChangeEntry[] = [];
    for (const c of fileChanges) (readSet.has(c.path) ? read : unread).push(c);
    return { unreadChanges: unread, readChanges: read };
  }, [fileChanges, readSet]);

  // Right-click context menu for a row (Copy path / Mark read · unread /
  // Revert) — webview-local, dismissed like the peek overlay (STATE_CONTRACT
  // § Webview-Local State).
  const [ctxMenu, setCtxMenu] = useState<FileChangeContextMenuState | null>(null);
  const openCtxMenu = useCallback((e: MouseEvent, change: FileChangeEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      path: change.path,
      kind: change.kind,
      read: readSet.has(change.path),
      triggerEl: getContextMenuTrigger(e),
    });
  }, [readSet]);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  // Row renderer shared by the unread + read groups. `isRead` drives the
  // darkened `is-read` treatment; the context menu captures read state at open.
  // Rows are keyboard-focusable so the ContextMenu key / Shift+F10 opens the
  // same row menu as a right-click (components/context-menu-key.ts).
  const renderRow = (change: FileChangeEntry, isRead: boolean) => (
    <div
      key={change.path}
      class={cx('file-change-item', `kind-${change.kind}`, isRead && 'is-read')}
      role="listitem"
      tabIndex={0}
      onContextMenu={(e) => openCtxMenu(e, change)}
      onKeyDown={(e) => handleContextMenuKeyRequest(e as KeyboardEvent)}
    >
      <div class="file-change-main">
        <FileName
          path={change.path}
          kind={change.kind}
          disabled={change.kind === 'deleted'}
          parentDepth={prefs.uiPathParentDepth}
          onClick={() => onOpenInEditor(change.path)}
        />
        <LineStats
          additions={change.additions}
          deletions={change.deletions}
          path={change.path}
          onDiff={() => onOpenDiff(change.path)}
        />
      </div>
    </div>
  );

  const { elRef, width: dragWidth, minWidth, maxWidth, startResize, resizeBy, reset } =
    useResizableWidth<HTMLDivElement>({ minWidth: 180, maxWidth: 520 });

  // hasNewChanges: pulse while unpinned and the count grows; clears on pin.
  useEffect(() => {
    const prev = prevCountRef.current;
    const curr = fileChanges.length;
    if (curr > prev && !pinned) setHasNewChanges(true);
    prevCountRef.current = curr;
    if (curr === 0) setHasNewChanges(false);
  }, [fileChanges.length, pinned]);

  // Pinning supersedes peek + clears the new-changes pulse. Also clear any
  // pending hover timer so a hover-then-quick-pin can't fire setPeeking(true)
  // after pinning (which would otherwise resurface the drawer as an overlay
  // when the user later unpins).
  useEffect(() => {
    if (pinned) {
      setHasNewChanges(false);
      setPeeking(false);
      if (openTimer.current) {
        clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    }
  }, [pinned]);

  // Clear any pending hover timers on unmount.
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const schedulePeekOpen = () => {
    if (!canHover || pinned) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (peeking || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      setPeeking(true);
      openTimer.current = null;
    }, PEEK_OPEN_DELAY);
  };

  const schedulePeekClose = () => {
    if (!canHover) return;
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!peeking || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      setPeeking(false);
      closeTimer.current = null;
    }, PEEK_CLOSE_DELAY);
  };

  // Dismiss peek on click-outside / Escape (touch + desktop). Active only
  // while peeking and not pinned.
  useEffect(() => {
    if (!peeking || pinned) return;
    const onDown = (e: MouseEvent) => {
      const rail = railRef.current;
      if (rail && !rail.contains(e.target as Node)) setPeeking(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPeeking(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [peeking, pinned]);

  if (fileChanges.length === 0) return null;

  const count = fileChanges.length;
  const showDrawer = pinned || peeking;
  const drawerMode = pinned ? 'is-pinned' : 'is-peek';
  // Drag width applies only when pinned; peek always uses the CSS default
  // (peek is transient — resizing it is out of scope).
  const innerWidth = pinned && dragWidth ? dragWidth : undefined;

  const onSliverClick = () => {
    if (canHover) {
      // Desktop: click pins (durable). Hover handles the transient peek.
      onToggleExpanded(!pinned);
    } else {
      // Touch: tap toggles peek; pin via the header pin button.
      setPeeking((p) => !p);
    }
  };

  const kindBreakdown = KIND_ORDER
    .map(({ kind, label }) => {
      const n = kindStats[kind].count;
      return n ? `${n} ${label.toLowerCase()}` : '';
    })
    .filter(Boolean)
    .join(', ');
  const sliverTitle =
    `${count} changed file${count === 1 ? '' : 's'}` +
    (kindBreakdown ? ` · ${kindBreakdown}` : '') +
    ` · +${totals.additions} / -${totals.deletions}`;

  return (
    <div
      ref={railRef}
      class={cx(
        'file-changes-rail',
        pinned && 'is-pinned',
        peeking && 'is-peeking',
        hasNewChanges && 'has-new-changes',
      )}
      onMouseEnter={schedulePeekOpen}
      onMouseLeave={schedulePeekClose}
    >
      {!pinned && (
        <button
          class="file-changes-sliver"
          type="button"
          onClick={onSliverClick}
          aria-expanded={peeking}
          aria-label={`File changes: ${count}. ${peeking ? 'Peeking' : canHover ? 'Hover or click to view' : 'Tap to view'}.`}
          title={sliverTitle}
        >
          <span class="file-changes-sliver-summary">
            <span class="file-changes-sliver-count">{count}</span>
            {(totals.additions > 0 || totals.deletions > 0) && (
              <span class="file-changes-sliver-magnitude">
                {totals.additions > 0 ? <span class="sliver-add">+{totals.additions}</span> : null}
                {totals.deletions > 0 ? <span class="sliver-del">-{totals.deletions}</span> : null}
              </span>
            )}
          </span>
          <span class="file-changes-sliver-files" aria-hidden="true">
            {fileChanges.map((c) => {
              const a = c.additions ?? 0;
              const d = c.deletions ?? 0;
              return (
                <span key={c.path} class={cx('sliver-file', `kind-${c.kind}`, readSet.has(c.path) && 'is-read')} title={`${c.path} · ${KIND_LABEL[c.kind]}`}>
                  <span class="sliver-file-row">
                    <span class="sliver-file-name">{formatPathWithParentDepth(c.path, prefs.uiPathParentDepth)}</span>
                  </span>
                  <span class="sliver-file-row sliver-file-stats">
                    {a ? <span class="sliver-file-add">+{a}</span> : null}
                    {d ? <span class="sliver-file-del">-{d}</span> : null}
                  </span>
                </span>
              );
            })}
          </span>
        </button>
      )}

      <div
        class={cx('file-changes-drawer', showDrawer && drawerMode)}
        aria-hidden={!showDrawer}
        inert={!showDrawer}
      >
        <div
          ref={elRef}
          class="file-changes-drawer-inner"
          style={innerWidth ? { width: `${innerWidth}px` } : undefined}
        >
          <div class="file-changes-header">
            <span class="file-changes-aggregate">
              <span class="file-changes-aggregate-count">{count} file{count === 1 ? '' : 's'}</span>
              <span class="file-changes-aggregate-diff">
                <span class="stat-additions">+{totals.additions}</span>
                <span class="stat-deletions">-{totals.deletions}</span>
              </span>
            </span>
            <span class="file-changes-header-actions">
              {peeking && !pinned ? (
                <button
                  class="action-btn icon-only file-changes-pin"
                  type="button"
                  aria-label="Keep file changes open (pin)"
                  title="Keep open (pin)"
                  onClick={() => onToggleExpanded(true)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4.5 1.5 H7.5 L6.6 4 V7 L8 8.5 H4 L5.4 7 V4 Z" />
                    <path d="M6 8.5 V10.5" />
                  </svg>
                </button>
              ) : null}
              {pinned ? (
                <button
                  class="action-btn icon-only file-changes-close"
                  type="button"
                  aria-label="Collapse file changes"
                  title="Collapse file changes"
                  onClick={() => onToggleExpanded(false)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="9,3 6,6 9,9" />
                  </svg>
                </button>
              ) : null}
            </span>
          </div>
          <div class="file-changes-list" role="list">
            {unreadChanges.map((change) => renderRow(change, false))}
            {readChanges.length > 0 && unreadChanges.length > 0 && (
              <div class="file-change-group-divider" aria-hidden="true">
                <span class="file-change-group-label">Reviewed</span>
              </div>
            )}
            {readChanges.map((change) => renderRow(change, true))}
          </div>
        </div>
      </div>
      {pinned && (
        <ResizeHandle
          edge="right"
          onMouseDown={startResize('right')}
          width={dragWidth}
          minWidth={minWidth}
          maxWidth={maxWidth}
          onResizeBy={resizeBy}
          onReset={reset}
          label="Drag to resize file-changes rail"
        />
      )}
      {ctxMenu && (
        <FileChangeContextMenu
          menu={ctxMenu}
          parentDepth={prefs.uiPathParentDepth}
          onOpenDiff={onOpenDiff}
          onOpenInEditor={onOpenInEditor}
          onRevert={onRevertFile}
          onSetFileRead={onSetFileRead}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  );
}
