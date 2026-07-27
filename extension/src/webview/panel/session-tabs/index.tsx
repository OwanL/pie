/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';

import type { ActiveRunSummary, ExtensionUIRequestPayload, SessionSummary } from '../../../shared/protocol';
import { DropGap } from './drop-gap';
import { FloatingSessionTab } from './floating-session-tab';
import { SessionTab } from './session-tab';
import { SessionTabContextMenu } from './session-tab-context-menu';
import type { SessionTabRunAction } from './run-state';
import { useTabDragAndDrop } from './use-drag-and-drop.js';

interface SessionTabsProps {
  sessions: SessionSummary[];
  openTabPaths: string[];
  pinnedTabPaths: string[];
  runningSessionPaths: string[];
  startingModelSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  backendReady?: boolean;
  hideConnectingWheel?: boolean;
  pendingExtensionUIRequestsBySession: Record<string, Record<string, import('../../../shared/protocol').ExtensionUIRequestPayload>>;
  runSummariesBySession: Record<string, ActiveRunSummary | null>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  onNew: () => void;
  onDuplicate: (path: string) => void;
  onTogglePin: (path: string) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
  /** Session paths that own a pending deferred trigger. Tabs in this set have
   *  their close × greyed out with an explanatory tooltip (the trigger must be
   *  cancelled first, from the status strip). */
  deferredSessionPaths: string[];
  /** Session paths whose pending deferred trigger includes a timer. */
  deferredTimerSessionPaths: string[];
}

function hasPendingRequest(
  map: Record<string, Record<string, ExtensionUIRequestPayload>>,
  sessionPath: string,
): boolean {
  const sessionMap = map[sessionPath];
  return !!sessionMap && Object.keys(sessionMap).length > 0;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function openSessionNamesEqual(previous: SessionTabsProps, next: SessionTabsProps): boolean {
  const previousNames = new Map(previous.sessions.map((session) => [session.path, session.name]));
  const nextNames = new Map(next.sessions.map((session) => [session.path, session.name]));
  return previous.openTabPaths.every((path) => previousNames.get(path) === nextNames.get(path));
}

function pendingRequestsEqual(previous: SessionTabsProps, next: SessionTabsProps): boolean {
  return previous.openTabPaths.every((path) => (
    hasPendingRequest(previous.pendingExtensionUIRequestsBySession, path)
    === hasPendingRequest(next.pendingExtensionUIRequestsBySession, path)
  ));
}

function runSummariesEqual(previous: SessionTabsProps, next: SessionTabsProps): boolean {
  return previous.openTabPaths.every((path) => {
    const left = previous.runSummariesBySession[path];
    const right = next.runSummariesBySession[path];
    return left === right || (
      left?.runId === right?.runId
      && left?.status === right?.status
      && left?.nextSendStartsNewTask === right?.nextSendStartsNewTask
    );
  });
}

function areSessionTabsPropsEqual(
  previous: Readonly<SessionTabsProps>,
  next: Readonly<SessionTabsProps>,
): boolean {
  return previous === next || (
    previous.activeSession?.path === next.activeSession?.path
    && previous.backendReady === next.backendReady
    && previous.hideConnectingWheel === next.hideConnectingWheel
    && previous.onSelect === next.onSelect
    && previous.onClose === next.onClose
    && previous.onMove === next.onMove
    && previous.onNew === next.onNew
    && previous.onDuplicate === next.onDuplicate
    && previous.onTogglePin === next.onTogglePin
    && previous.onRunAction === next.onRunAction
    && stringArraysEqual(previous.openTabPaths, next.openTabPaths)
    && stringArraysEqual(previous.pinnedTabPaths, next.pinnedTabPaths)
    && stringArraysEqual(previous.runningSessionPaths, next.runningSessionPaths)
    && stringArraysEqual(previous.startingModelSessionPaths, next.startingModelSessionPaths)
    && stringArraysEqual(previous.unreadFinishedSessionPaths, next.unreadFinishedSessionPaths)
    && stringArraysEqual(previous.deferredSessionPaths, next.deferredSessionPaths)
    && stringArraysEqual(previous.deferredTimerSessionPaths, next.deferredTimerSessionPaths)
    && openSessionNamesEqual(previous, next)
    && pendingRequestsEqual(previous, next)
    && runSummariesEqual(previous, next)
  );
}

function SessionTabsView({
  sessions,
  openTabPaths,
  pinnedTabPaths,
  runningSessionPaths,
  startingModelSessionPaths,
  unreadFinishedSessionPaths,
  activeSession,
  backendReady,
  hideConnectingWheel,
  pendingExtensionUIRequestsBySession,
  runSummariesBySession,
  onSelect,
  onClose,
  onMove,
  onNew,
  onDuplicate,
  onTogglePin,
  onRunAction,
  deferredSessionPaths,
  deferredTimerSessionPaths,
}: SessionTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);

  // Optimistic active-tab highlight. `onSelect` (click / keyboard) only posts
  // `openSession` and waits for the host round-trip to confirm via the next
  // `state`'s `activeSession`. Without this override the clicked tab doesn't
  // highlight until that round-trip completes — the "nothing happens on click"
  // lag. We reflect the click immediately: `effectiveActivePath` (below)
  // falls back to the host's `activeSession.path` once the override clears.
  // The override clears when the host confirms (activeSession.path ===
  // optimistic) or after a 2s safety timeout (rejection / closed-before-
  // confirm). Only the tab-bar highlight is optimistic — the transcript /
  // composer still wait for the host, since they need the new session's data.
  const [optimisticActivePath, setOptimisticActivePath] = useState<string | null>(null);
  const optimisticTimerRef = useRef<number | null>(null);

  const selectTab = useCallback((path: string) => {
    setOptimisticActivePath(path);
    if (optimisticTimerRef.current !== null) clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = window.setTimeout(() => {
      optimisticTimerRef.current = null;
      setOptimisticActivePath(null);
    }, 2000);
    onSelect(path);
  }, [onSelect]);

  const {
    dragState,
    tabContextMenu,
    onPointerDown,
    onClick,
    onContextMenu,
    onContextAction,
    ghostElementRef,
  } = useTabDragAndDrop({
    openTabPaths,
    pinnedTabPaths,
    onMove,
    onSelect: selectTab,
    onClose,
    onDuplicate,
    onTogglePin,
    onRunAction,
    stripRef,
  });

  const effectiveActivePath = optimisticActivePath ?? activeSession?.path ?? null;

  // Clear the override once the host confirms the active session matches.
  useEffect(() => {
    if (optimisticActivePath !== null && activeSession?.path === optimisticActivePath) {
      if (optimisticTimerRef.current !== null) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
      setOptimisticActivePath(null);
    }
  }, [activeSession?.path, optimisticActivePath]);

  // Clean up the safety timeout on unmount.
  useEffect(() => () => {
    if (optimisticTimerRef.current !== null) clearTimeout(optimisticTimerRef.current);
  }, []);

  // If the optimistically-selected tab is closed before the host confirms the
  // switch (click then immediate close), clear the override so the highlight
  // falls back to the host's actual active session instead of lingering on a
  // now-unrendered tab until the 2s safety timeout. The body short-circuits on
  // `optimisticActivePath === null` (the common case), so the per-snapshot
  // `openTabPaths` dep churn during streaming costs only a null check.
  useEffect(() => {
    if (optimisticActivePath !== null && !openTabPaths.includes(optimisticActivePath)) {
      if (optimisticTimerRef.current !== null) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
      setOptimisticActivePath(null);
    }
  }, [openTabPaths, optimisticActivePath]);

  // Stabilize derived collections so memoized children (SessionTab, DropGap)
  // skip re-render while their props are unchanged — essential during a drag,
  // where the parent re-renders on every pointermove.
  const sessionByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions]);
  const openIndexByPath = useMemo(() => new Map(openTabPaths.map((path, index) => [path, index])), [openTabPaths]);
  const runningPathSet = useMemo(() => new Set(runningSessionPaths), [runningSessionPaths]);
  const startingModelPathSet = useMemo(() => new Set(startingModelSessionPaths), [startingModelSessionPaths]);
  const unreadFinishedPathSet = useMemo(() => new Set(unreadFinishedSessionPaths), [unreadFinishedSessionPaths]);
  const pinnedPathSet = useMemo(() => new Set(pinnedTabPaths), [pinnedTabPaths]);
  const deferredPathSet = useMemo(() => new Set(deferredSessionPaths), [deferredSessionPaths]);
  const deferredTimerPathSet = useMemo(
    () => new Set(deferredTimerSessionPaths),
    [deferredTimerSessionPaths],
  );

  // Re-resolve the dragged index from the source path each render so a tab
  // closing or being inserted elsewhere mid-drag doesn't float the wrong tab.
  const draggedSourcePath = dragState?.sourcePath ?? null;
  const draggedSourceIndex = draggedSourcePath !== null ? openTabPaths.indexOf(draggedSourcePath) : -1;
  const draggedPath = draggedSourceIndex >= 0 ? draggedSourcePath : null;
  const renderedTabPaths = draggedSourceIndex >= 0
    ? openTabPaths.filter((_, index) => index !== draggedSourceIndex)
    : openTabPaths;
  const dragGapWidth = dragState
    ? Math.max(18, Math.min(34, Math.round(dragState.tabWidth * 0.22)))
    : 0;
  // Primitives for the memoized DropGap: only `dropIndex` (and the static
  // geometry) reach it, so it skips re-render until the drop target changes.
  const activeDropIndex = dragState?.dropIndex ?? null;
  const dropTabHeight = dragState?.tabHeight ?? 0;

  // Tabs-1: scroll the active tab into view when the active session changes
  // (host selection, closing an adjacent tab, DnD commit near an edge).
  // `inline: 'nearest'` scrolls only the minimum needed; no-op if visible.
  useEffect(() => {
    if (!effectiveActivePath) return;
    const strip = stripRef.current;
    if (!strip) return;
    const tab = Array.from(strip.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'))
      .find((el) => el.getAttribute('data-tab-path') === effectiveActivePath);
    tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [effectiveActivePath]);

  // Tabs-4: surface horizontal overflow with edge fades. Re-measures on strip
  // resize (ResizeObserver), scroll position, and tab/content changes (deps).
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const update = () => {
      const hasOverflow = strip.scrollWidth - strip.clientWidth > 1;
      setFadeLeft(hasOverflow && strip.scrollLeft > 1);
      setFadeRight(hasOverflow && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    };
    update();
    strip.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(strip);
    return () => {
      strip.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, [openTabPaths, sessions]);

  // Tabs: VS Code-style wheel scrolling. The strip scrolls natively only on
  // horizontal / shift+wheel input; translate plain vertical wheel deltas into
  // horizontal scrolling so hovering the tab bar and scrolling moves tabs
  // left/right. When the strip isn't overflowing the wheel passes through to the
  // page; while overflowing we trap it (preventDefault) so the tab bar owns the
  // gesture instead of scrolling the transcript behind it. Non-passive so we
  // can call preventDefault.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      // Let native horizontal input (trackpad / shift+wheel) handle itself.
      if (event.deltaX !== 0) return;
      if (event.deltaY === 0) return;
      if (strip.scrollWidth - strip.clientWidth <= 1) return;
      // At a matching scroll limit, let the wheel pass through to the page
      // (transcript) instead of trapping it — avoids the overscroll trap.
      const atLeft = strip.scrollLeft <= 1;
      const atRight = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
      if ((atLeft && event.deltaY < 0) || (atRight && event.deltaY > 0)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  // Tabs-5: roving-tabindex keyboard navigation (WAI-ARIA Tabs). Arrow keys
  // move focus and select the adjacent tab; Home/End jump to the ends; Delete
  // closes the focused tab and restores focus to its neighbor (which the host
  // also selects as the next active tab, keeping roving consistent). Disabled
  // during an active pointer drag.
  const onTabListKeyDown = useCallback((event: KeyboardEvent) => {
    if (dragState) return;
    const strip = stripRef.current;
    if (!strip) return;
    const target = event.target as HTMLElement | null;
    const tabEl = target ? (target.closest('.session-tab[data-tab-path]') as HTMLElement | null) : null;
    if (!tabEl) return;
    const tabPath = tabEl.getAttribute('data-tab-path');
    if (!tabPath) return;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'));
    const currentIndex = tabs.indexOf(tabEl);
    if (currentIndex === -1) return;

    if (event.key === 'Delete') {
      event.preventDefault();
      // A tab with a pending deferred trigger cannot be closed (greyed-out ×).
      // Mirror that guard on the keyboard shortcut so Delete can't bypass it
      // and orphan the trigger.
      if (deferredPathSet.has(tabPath)) return;
      const fallbackIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : currentIndex - 1;
      const fallbackPath = fallbackIndex >= 0 ? tabs[fallbackIndex]?.getAttribute('data-tab-path') : null;
      onClose(tabPath);
      if (fallbackPath) {
        requestAnimationFrame(() => {
          const s = stripRef.current;
          if (!s) return;
          const next = Array.from(s.querySelectorAll<HTMLElement>('.session-tab[data-tab-path]'))
            .find((el) => el.getAttribute('data-tab-path') === fallbackPath);
          next?.querySelector<HTMLElement>('[role="tab"]')?.focus();
        });
      }
      return;
    }

    let targetIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      targetIndex = Math.min(currentIndex + 1, tabs.length - 1);
    } else if (event.key === 'ArrowLeft') {
      targetIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = tabs.length - 1;
    }
    if (targetIndex === null) return;
    event.preventDefault();
    const targetTab = tabs[targetIndex];
    const targetPath = targetTab?.getAttribute('data-tab-path');
    if (targetPath && targetPath !== tabPath) {
      selectTab(targetPath);
    }
    targetTab?.querySelector<HTMLElement>('[role="tab"]')?.focus();
  }, [dragState, onClose, selectTab, deferredPathSet]);

  const stripClass = `session-tabs-strip${fadeLeft ? ' fade-left' : ''}${fadeRight ? ' fade-right' : ''}`;

  return (
    <div class={`session-tabs${dragState ? ' dragging' : ''}`}>
      <div
        ref={stripRef}
        class={stripClass}
        role="tablist"
        aria-label="Sessions"
        onKeyDown={(event) => onTabListKeyDown(event as KeyboardEvent)}
      >
        {renderedTabPaths.map((tabPath, index) => [
          <DropGap key={`drop-gap:${index}`} index={index} dropIndex={activeDropIndex} tabHeight={dropTabHeight} dragGapWidth={dragGapWidth} />,
          <SessionTab
            key={tabPath}
            tabPath={tabPath}
            index={index}
            sessionByPath={sessionByPath}
            openIndexByPath={openIndexByPath}
            runningPathSet={runningPathSet}
            startingModelPathSet={startingModelPathSet}
            unreadFinishedPathSet={unreadFinishedPathSet}
            activePath={effectiveActivePath}
            hasPendingExtensionUIRequest={hasPendingRequest(pendingExtensionUIRequestsBySession, tabPath)}
            isPinned={pinnedPathSet.has(tabPath)}
            hasDeferredTriggers={deferredPathSet.has(tabPath)}
            hasDeferredTimer={deferredTimerPathSet.has(tabPath)}
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onClose={onClose}
          />,
        ])}
        <DropGap index={renderedTabPaths.length} dropIndex={activeDropIndex} tabHeight={dropTabHeight} dragGapWidth={dragGapWidth} />
      </div>
      <div class="session-tabs-actions">
        <button
          class="session-tabs-new"
          type="button"
          title="New session"
          onClick={onNew}
          aria-label="New session"
        >
          +
        </button>
        {!backendReady && !hideConnectingWheel && (
          <span class="session-tabs-connecting" title="Connecting to backend…" aria-label="Connecting">
            <span class="loading-wheel loading-wheel-sm" aria-hidden="true" />
          </span>
        )}
      </div>
      {dragState && draggedPath && (
        <FloatingSessionTab
          dragState={dragState}
          draggedPath={draggedPath}
          sessionByPath={sessionByPath}
          runningPathSet={runningPathSet}
          activeSession={activeSession}
          isPinned={pinnedPathSet.has(draggedPath)}
          ghostRef={ghostElementRef}
        />
      )}
      {tabContextMenu && (
        <SessionTabContextMenu
          tabContextMenu={tabContextMenu}
          sessionByPath={sessionByPath}
          runSummary={runSummariesBySession[tabContextMenu.tabPath] ?? null}
          isPinned={pinnedPathSet.has(tabContextMenu.tabPath)}
          hasDeferredTriggers={deferredPathSet.has(tabContextMenu.tabPath)}
          onContextAction={onContextAction}
        />
      )}
    </div>
  );
}

export const SessionTabs = memo(SessionTabsView, areSessionTabsPropsEqual);

export { SessionTab } from './session-tab';
