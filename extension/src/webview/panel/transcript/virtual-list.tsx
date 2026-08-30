/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { VirtualItem, Virtualizer, elementScroll, measureElement as measureVirtualElement, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';

import { type ChatMessage, type ChatPrefs, type ComposerInput, type PruningResult, type PruningSettings, type SystemPromptEntry, type ThinkingLevel, type ToolCall, type TranscriptWindow } from '../../../shared/protocol';
import { deriveTurnActivityState } from './activity';
import { MessageRail } from './message-rail';
import { createMessageRailJumpController, type MessageRailJumpController } from './message-rail-jump';
import { TranscriptScrollbar } from './transcript-scrollbar';
import { UserPromptContextBar } from './user-prompt-context-bar';
import { buildUserPromptEntries } from './user-prompt-context';
import { isReusableTranscriptMeasurementElement, isReusableTranscriptMeasurementRow, transcriptMeasurementCache } from './transcript-measurement-cache';
import { ToolCallItem } from './tool-call-item';
import { useTranscriptScroll } from './use-transcript-scroll';
import { useTranscriptScrollAnchor } from './use-transcript-scroll-anchor';
import { handleTranscriptClick } from './transcript-click-handler';
import { cx } from '../utils/cx';
import type {
  RenderToolCall,
  TranscriptContextMenuHandler,
  TranscriptVirtualListProps,
} from './types';
import { TranscriptVirtualRow } from './virtual-list-row';
import { extractRangeWithPinnedIndexes } from './virtual-range';
import { buildTranscriptRows, estimateTranscriptRowSize, scopeTranscriptRowsToSession, type TranscriptRow } from './virtual-list-rows';

// Count-based overscan must stay small because a single transcript row can be
// a multi-minute assistant turn containing dozens of collapsed tool cards.
// One row covers the adjacent user/assistant boundary during ordinary wheel
// movement without eagerly mounting an entire short-but-very-heavy transcript.
const TRANSCRIPT_OVERSCAN_ROWS = 1;

function measureTranscriptElement(
  rows: readonly TranscriptRow[],
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
): number {
  const size = measureVirtualElement(element, entry, virtualizer);
  const index = virtualizer.indexFromElement(element);
  const row = rows[index];
  if (row) {
    const observedWidth = entry?.borderBoxSize[0]?.inlineSize;
    const width = typeof observedWidth === 'number'
      ? observedWidth
      : element.getBoundingClientRect().width;
    transcriptMeasurementCache.observeWidth(width);
    // Streaming rows remeasure on nearly every chunk. Reject them before the
    // descendant query so cache bookkeeping never adds a live-turn DOM scan.
    if (isReusableTranscriptMeasurementRow(row)
      && isReusableTranscriptMeasurementElement(element)) {
      transcriptMeasurementCache.remember(row, width, size);
    }
  }
  return size;
}

function fallbackTranscriptRow(rows: readonly TranscriptRow[]): TranscriptRow {
  return rows[rows.length - 1] ?? { kind: 'bottomGap', key: 'fallback-gap' };
}

function getRowRole(row: TranscriptRow | undefined): string | null {
  if (row?.kind === 'message') return row.message.role;
  if (row?.kind === 'systemPrompts') return 'system';
  return null;
}

function useTranscriptRows({
  sessionKey,
  transcript,
  systemPrompts,
  transcriptWindow,
  busy,
  compacting,
  liveTurnPhase,
  prefs,
  pruningSettings,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: {
  sessionKey: string | null;
  transcript: ChatMessage[];
  systemPrompts: SystemPromptEntry[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  compacting?: boolean;
  liveTurnPhase?: TranscriptVirtualListProps['liveTurnPhase'];
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
}) {
  const activityState = useMemo(() => deriveTurnActivityState({
    busy,
    compacting,
    transcript,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
    liveTurnPhase,
  }), [busy, compacting, transcript, prefs, pruningSettings, pendingAssistantModelId, pendingAssistantThinkingLevel, liveTurnPhase]);

  const rows = useMemo(() => scopeTranscriptRowsToSession(buildTranscriptRows({
    transcript,
    systemPromptCount: systemPrompts.length,
    hasOlder: transcriptWindow.hasOlder,
    hasNewer: transcriptWindow.hasNewer,
    olderCount: transcriptWindow.loadedStart,
    newerCount: Math.max(0, transcriptWindow.totalCount - transcriptWindow.loadedEnd),
    busy,
    showPruningMessages: prefs.showPruningMessages,
    activityState,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  }), sessionKey), [sessionKey, systemPrompts.length, transcript, transcriptWindow.hasOlder, transcriptWindow.hasNewer, transcriptWindow.loadedStart, transcriptWindow.loadedEnd, transcriptWindow.totalCount, busy, prefs.showPruningMessages, activityState, pendingAssistantModelId, pendingAssistantThinkingLevel]);

  return rows;
}

function useTranscriptVirtualizer(
  rows: readonly TranscriptRow[],
  scrollRef: { current: HTMLDivElement | null },
  editingId: string | null,
) {
  const [, setRenderTick] = useState(0);
  const renderFrameRef = useRef<number | null>(null);
  // The inline editor deliberately owns its live keystroke buffer. Keep its
  // row in TanStack's range even when scroll/streaming would otherwise unmount
  // it, so that buffer cannot reset before it is committed to host state.
  const pinnedIndexes = useMemo(() => editingId === null
    ? []
    : rows.flatMap((row, index) => row.kind === 'message' && row.message.id === editingId ? [index] : []), [editingId, rows]);
  const rangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
      // A click can expand a tall tool card and move its row outside a narrow
      // virtual window during the same measurement frame. Keep the focused row
      // mounted so the control and its newly opened content cannot disappear
      // underneath the user's pointer. Once focus leaves, normal virtualization
      // resumes; inline editing remains pinned independently above.
      const activeElement = scrollRef.current?.ownerDocument.activeElement;
      const focusedRow = activeElement?.closest<HTMLElement>('[data-index]') ?? null;
      const focusedIndex = Number(focusedRow?.dataset.index);
      const focusPinned = Number.isSafeInteger(focusedIndex) && focusedIndex >= 0
        ? [focusedIndex]
        : [];
      const expandedPinned = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [])]
        .filter((row) => row.querySelector('.tool-call-header[aria-expanded="true"]'))
        .flatMap((row) => {
          const index = Number(row.dataset.index);
          return Number.isSafeInteger(index) && index >= 0 ? [index] : [];
        });
      return extractRangeWithPinnedIndexes(range, [...pinnedIndexes, ...focusPinned, ...expandedPinned]);
    },
    [pinnedIndexes, scrollRef],
  );

  const scheduleVirtualRender = useCallback(() => {
    if (renderFrameRef.current !== null) {
      return;
    }

    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      setRenderTick((value) => value + 1);
    });
  }, []);

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (!virtualizerRef.current) {
    const initialMeasurements = transcriptMeasurementCache.createInitialMeasurements(rows);
    virtualizerRef.current = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      initialOffset: () => Number.MAX_SAFE_INTEGER,
      initialMeasurementsCache: initialMeasurements.measurements,
      rangeExtractor,
      overscan: TRANSCRIPT_OVERSCAN_ROWS,
      // Batch ResizeObserver-driven re-measurements with the next animation
      // frame. Without this, content that grows after initial measurement
      // (streaming markdown, late-loading tables/images) can leave a one-paint
      // window where the cached row size is smaller than the rendered height,
      // causing the next absolute-positioned row to overlap the previous one
      // (visible as a user-message bubble painted over an earlier assistant
      // message). The animation-frame batching closes that race.
      useAnimationFrameWithResizeObserver: true,
      measureElement: (element, entry, instance) => measureTranscriptElement(rows, element, entry, instance),
      onChange: scheduleVirtualRender,
    });
  }

  const virtualizer = virtualizerRef.current;

  useLayoutEffect(() => {
    virtualizer.setOptions({
      ...virtualizer.options,
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      // The constructor-only cross-remount cache has already been consumed.
      // Do not let a later temporary zero-row state resurrect stale entries.
      initialMeasurementsCache: [],
      rangeExtractor,
      overscan: TRANSCRIPT_OVERSCAN_ROWS,
      useAnimationFrameWithResizeObserver: true,
      measureElement: (element, entry, instance) => measureTranscriptElement(rows, element, entry, instance),
      onChange: scheduleVirtualRender,
    });
    virtualizer._willUpdate();
  }, [rangeExtractor, rows, scheduleVirtualRender, virtualizer]);

  useEffect(() => {
    const cleanup = virtualizer._didMount();
    return cleanup;
  }, [virtualizer]);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  }, []);

  return virtualizer;
}

function useTranscriptRenderToolCall({
  prefs,
  workingDirectory,
  onOpenFile,
}: {
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
}) {
  const renderToolCallRef = useRef<RenderToolCall>((_toolCall, _contextMenuHandler) => null);
  const renderToolCall = useCallback<RenderToolCall>((toolCall: ToolCall, contextMenuHandler: TranscriptContextMenuHandler) => (
    <ToolCallItem
      toolCall={toolCall}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={contextMenuHandler}
      renderToolCall={renderToolCallRef.current}
    />
  ), [onOpenFile, prefs, workingDirectory]);
  renderToolCallRef.current = renderToolCall;
  return renderToolCall;
}

interface VirtualRowProps {
  virtualRow: VirtualItem;
  rows: readonly TranscriptRow[];
  lastRow: TranscriptRow | undefined;
  busy: boolean;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  workingDirectory: string | null;
  editingId: string | null;
  editingDraft: TranscriptVirtualListProps['editingDraft'];
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[], queued?: boolean) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onRequestOlder: () => void;
  onRequestNewer: () => void;
  renderToolCall: RenderToolCall;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  sessionKey: string | null;
  measureRowElement: (element: HTMLDivElement | null) => void;
  onCancelPrepass?: () => void;
}

const VirtualRow = memo(function VirtualRow({
  virtualRow,
  rows,
  lastRow,
  busy,
  prefs,
  systemPrompts,
  pruningResult,
  workingDirectory,
  editingId,
  editingDraft,
  isLoadingOlder,
  isLoadingNewer,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onRequestOlder,
  onRequestNewer,
  renderToolCall,
  transcript,
  transcriptWindow,
  sessionKey,
  measureRowElement,
  onCancelPrepass,
}: VirtualRowProps) {
  const row = rows[virtualRow.index];
  if (!row) {
    return null;
  }

  const previousRole = getRowRole(rows[virtualRow.index - 1]);
  const currentRole = getRowRole(row);
  const isRoleTransition = !!previousRole && !!currentRole && previousRole !== currentRole;

  return (
    <div
      data-index={virtualRow.index}
      ref={measureRowElement}
      class={cx(
        'absolute start-0 top-0 box-border flex w-full flex-col items-start',
        isRoleTransition ? 'pb-4' : 'pb-1.5',
      )}
      style={{ transform: `translateY(${virtualRow.start}px)` }}
    >
      <TranscriptVirtualRow
        row={row}
        busy={busy}
        prefs={prefs}
        systemPrompts={systemPrompts}
        pruningResult={pruningResult}
        workingDirectory={workingDirectory}
        editingId={editingId}
        editingDraft={editingDraft}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        isLastRow={row === lastRow}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        onRequestOlder={onRequestOlder}
        onRequestNewer={onRequestNewer}
        renderToolCall={renderToolCall}
        transcript={transcript}
        transcriptIndex={row.kind === 'message' ? row.transcriptIndex : undefined}
        hasOlder={transcriptWindow.hasOlder}
        sessionKey={sessionKey}
        onCancelPrepass={onCancelPrepass}
      />
    </div>
  );
});

export function TranscriptVirtualList({
  sessionKey,
  transcript,
  transcriptWindow,
  busy,
  compacting,
  liveTurnPhase,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
  editingDraft,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
  onCancelPrepass,
}: TranscriptVirtualListProps) {
  const rows = useTranscriptRows({
    sessionKey,
    transcript,
    systemPrompts,
    transcriptWindow,
    busy,
    compacting,
    liveTurnPhase,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  });
  // Prompt entries are rebuilt with the row model — a cheap index of source
  // message references plus flags (no per-prompt text normalization). The
  // context bar binary-searches this ordered index per render and derives the
  // selected prompt's text lazily, re-checking on the element's own scroll
  // events even inside an unchanged virtual range.
  const userPromptEntries = useMemo(() => buildUserPromptEntries(rows), [rows]);

  // Owned here (not inside useTranscriptScroll) so the virtualizer can be
  // created from it BEFORE the scroll hook runs — letting the hook receive the
  // virtualizer's `totalSize` as a reactive prop, which drives its follow-target
  // refresh (every content-height change flows through totalSize).
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useTranscriptVirtualizer(rows, scrollRef, editingId);

  const renderToolCall = useTranscriptRenderToolCall({
    prefs,
    workingDirectory,
    onOpenFile,
  });

  // Stable ref: tanstack's `measureElement` measures synchronously on mount and
  // registers a ResizeObserver (batched with rAF via
  // `useAnimationFrameWithResizeObserver`) that re-measures on subsequent height
  // changes (streaming markdown, late tables/images). A stable callback avoids
  // re-binding the observer and re-running getBoundingClientRect on every
  // visible row every render.
  // Pass `null` through (no guard): tanstack's `measureElement(null)` is the
  // only path that iterates `elementsCache` and unobserves/disconnects rows that
  // virtualized out of the overscan window. The previous `if (element)` guard
  // dropped the null call, so every scrolled-past row leaked in `elementsCache`,
  // still observed by the shared ResizeObserver and retaining its detached DOM.
  // The callback stays stable (deps `[virtualizer]`) so the ref is not re-bound
  // on every render — the whole reason the stable callback exists.
  const measureRowElement = useCallback(
    (element: HTMLDivElement | null) => { virtualizer.measureElement(element); },
    [virtualizer],
  );

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const lastRow = rows[rows.length - 1];

  const {
    autoFollowRef,
    manualScrollActiveRef,
    programmaticScrollTargetRef,
    navigationActiveRef,
    setAutoFollow,
    isAtBottom,
    isInitialPositioning,
    isLoadingOlder,
    isLoadingNewer,
    requestOlderPage,
    requestNewerPage,
    jumpToLatest,
  } = useTranscriptScroll({
    scrollRef,
    sessionKey,
    transcriptWindow,
    transcript,
    transcriptLength: transcript.length,
    busy,
    onLoadOlder,
    onLoadNewer,
    onJumpToLatest,
    pagingSuspended: editingId !== null,
    totalSize,
  });

  // Disable tanstack virtual's built-in scroll-position correction. Scroll
  // ownership must be exclusive: bottom-follow is handled by exact pinning and
  // the scrolled-up viewport is handled by useTranscriptScrollAnchor below.
  // Leaving tanstack's overflow-anchor-like correction enabled while scrolled
  // up makes both systems apply the same row-size delta, which causes the
  // transcript to drift and jump as streaming rows are remeasured.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  }, [virtualizer]);

  // Pin the top visible row when the user has scrolled up and a tool body
  // above the viewport resizes (Tier 2). No-op while pinned to the bottom
  // (auto-follow owns that) or while paginating (dedicated restore owns that).
  useTranscriptScrollAnchor({
    scrollRef,
    virtualizer,
    autoFollowRef,
    manualScrollActiveRef,
    programmaticScrollTargetRef,
    totalSize,
    rowKeys,
    navigationActiveRef,
    isLoadingOlder,
    isLoadingNewer,
  });

  // Both the rail and the context bar use one bounded controller. Sharing the
  // instance prevents two app-owned settle loops from competing if a user
  // changes navigation target before the first jump has released ownership.
  const jumpControllerRef = useRef<MessageRailJumpController | null>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const controller = createMessageRailJumpController({
      element,
      getRowStart: (rowIndex) => virtualizer.measurementsCache[rowIndex]?.start ?? null,
      navigationActiveRef,
      programmaticScrollTargetRef,
      setAutoFollow,
    });
    jumpControllerRef.current = controller;
    return () => {
      controller.dispose();
      if (jumpControllerRef.current === controller) jumpControllerRef.current = null;
    };
  }, [navigationActiveRef, programmaticScrollTargetRef, scrollRef, setAutoFollow, virtualizer]);
  const jumpToRow = useCallback((rowIndex: number) => {
    jumpControllerRef.current?.jumpTo(rowIndex);
  }, []);

  return (
    <div class="transcript-virtual-wrap">
      <UserPromptContextBar
        entries={userPromptEntries}
        virtualizer={virtualizer}
        scrollRef={scrollRef}
        isAtBottom={isAtBottom}
        hidden={isInitialPositioning}
        onLocate={jumpToRow}
      />
      <div class="transcript-viewport">
        <div
          class={`transcript transcript-virtual${isInitialPositioning ? ' transcript-positioning' : ''}`}
          ref={scrollRef}
          onClick={handleTranscriptClick}
        >
          <div class="transcript-virtual-inner" style={{ height: `${totalSize}px` }}>
          {virtualRows.map((virtualRow) => (
            <VirtualRow
              key={virtualRow.key}
              virtualRow={virtualRow}
              rows={rows}
              lastRow={lastRow}
              busy={busy}
              prefs={prefs}
              systemPrompts={systemPrompts}
              pruningResult={pruningResult}
              workingDirectory={workingDirectory}
              editingId={editingId}
              editingDraft={editingDraft}
              isLoadingOlder={isLoadingOlder}
              isLoadingNewer={isLoadingNewer}
              onEditRequest={onEditRequest}
              onEditConfirm={onEditConfirm}
              onEditCancel={onEditCancel}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              onRequestOlder={requestOlderPage}
              onRequestNewer={requestNewerPage}
              renderToolCall={renderToolCall}
              transcript={transcript}
              transcriptWindow={transcriptWindow}
              measureRowElement={measureRowElement}
              sessionKey={sessionKey}
              onCancelPrepass={onCancelPrepass}
            />
          ))}
        </div>

          {(!isAtBottom || transcriptWindow.hasNewer) && (
            <button
              type="button"
              class="transcript-jump-latest"
              aria-label="Jump to bottom"
              title="Jump to bottom"
              onClick={jumpToLatest}
            >
              <span class="transcript-jump-latest-icon" aria-hidden="true">↓</span>
              <span>Bottom</span>
            </button>
          )}
        </div>
        <MessageRail
          rows={rows}
          virtualizer={virtualizer}
          scrollRef={scrollRef}
          setAutoFollow={setAutoFollow}
          navigationActiveRef={navigationActiveRef}
          programmaticScrollTargetRef={programmaticScrollTargetRef}
          markerSize={prefs.uiMessageRailSize}
          onJumpToRow={jumpToRow}
          hidden={isInitialPositioning}
        />
        <TranscriptScrollbar
          scrollRef={scrollRef}
          totalSize={totalSize}
          hidden={isInitialPositioning}
        />
      </div>
    </div>
  );
}
