/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { VirtualItem, Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';

import { type ChatMessage, type ChatPrefs, type PruningResult, type PruningSettings, type SystemPromptEntry, type ThinkingLevel, type ToolCall, type TranscriptWindow } from '../../../shared/protocol';
import { deriveTurnActivityState } from './activity';
import { MessageRail } from './message-rail';
import { ToolCallItem } from './tool-call-item';
import { useTranscriptScroll } from './use-transcript-scroll';
import { useTranscriptScrollAnchor } from './use-transcript-scroll-anchor';
import { handleTranscriptClick } from './transcript-click-handler';
import { cx } from '../utils/cx';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { TranscriptVirtualRow } from './virtual-list-row';
import { buildTranscriptRows, estimateTranscriptRowSize, type TranscriptRow } from './virtual-list-rows';

interface TranscriptVirtualListProps {
  sessionKey: string | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  onCancelPrepass?: () => void;
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
  transcript,
  systemPrompts,
  transcriptWindow,
  busy,
  pruningResult,
  prefs,
  pruningSettings,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: {
  transcript: ChatMessage[];
  systemPrompts: SystemPromptEntry[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  pruningResult: PruningResult | null;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
}) {
  const activityState = useMemo(() => deriveTurnActivityState({
    busy,
    transcript,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  }), [busy, transcript, prefs, pruningSettings, pendingAssistantModelId, pendingAssistantThinkingLevel]);

  const rows = useMemo(() => buildTranscriptRows({
    transcript,
    systemPromptCount: systemPrompts.length,
    hasOlder: transcriptWindow.hasOlder,
    hasNewer: transcriptWindow.hasNewer,
    busy,
    hasPruningResult: pruningResult !== null,
    showPruningMessages: prefs.showPruningMessages,
    activityState,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  }), [systemPrompts.length, transcript, transcriptWindow.hasOlder, transcriptWindow.hasNewer, busy, pruningResult, prefs.showPruningMessages, activityState, pendingAssistantModelId, pendingAssistantThinkingLevel]);

  return rows;
}

function useTranscriptVirtualizer(
  rows: readonly TranscriptRow[],
  scrollRef: { current: HTMLDivElement | null },
) {
  const [, setRenderTick] = useState(0);
  const renderFrameRef = useRef<number | null>(null);

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
    virtualizerRef.current = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      initialOffset: () => Number.MAX_SAFE_INTEGER,
      overscan: 10,
      // Batch ResizeObserver-driven re-measurements with the next animation
      // frame. Without this, content that grows after initial measurement
      // (streaming markdown, late-loading tables/images) can leave a one-paint
      // window where the cached row size is smaller than the rendered height,
      // causing the next absolute-positioned row to overlap the previous one
      // (visible as a user-message bubble painted over an earlier assistant
      // message). The animation-frame batching closes that race.
      useAnimationFrameWithResizeObserver: true,
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
      overscan: 10,
      useAnimationFrameWithResizeObserver: true,
      onChange: scheduleVirtualRender,
    });
    virtualizer._willUpdate();
  }, [rows, scheduleVirtualRender, virtualizer]);

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
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
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
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
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
    transcript,
    systemPrompts,
    transcriptWindow,
    busy,
    pruningResult,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  });

  // Owned here (not inside useTranscriptScroll) so the virtualizer can be
  // created from it BEFORE the scroll hook runs — letting the hook receive the
  // virtualizer's `totalSize` as a reactive prop, which drives its follow-target
  // refresh (every content-height change flows through totalSize).
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useTranscriptVirtualizer(rows, scrollRef);

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
  const lastRow = rows[rows.length - 1];

  const {
    autoFollowRef,
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
    totalSize,
  });

  // Disable tanstack virtual's built-in scroll-position correction
  // (`shouldAdjustScrollPositionOnItemSizeChange`) while auto-follow is engaged.
  // The default mimics `overflow-anchor`: when a row above the viewport resizes
  // it writes `scrollTop` (via `_scrollToOffset`) to keep the visible content
  // stable. That write happens in the virtualizer's measure rAF, BEFORE
  // `scheduleVirtualRender` defers the re-render that updates the inner div's
  // explicit `height: totalSize` (and thus `el.scrollHeight`) by a frame. The
  // resulting scroll event therefore sees a stale-high `scrollHeight` paired
  // with a freshly-lowered `scrollTop` → `distanceFromBottom` reads large →
  // `isNearBottom` is false → `resolveAutoFollowState` disengages auto-follow on
  // a downward move that was actually a shrink-correction, not a user scroll-up.
  // This is the root cause of "autoscroll stops after a tool-card animated
  // close" (two parallel collapsing cards produce a tall shrink above the
  // viewport). While following the bottom, our rAF loop + the browser's own
  // scrollTop clamp (on the deferred height update) own the follow, so
  // tanstack's correction is unneeded and harmful here. While scrolled up it
  // stays enabled (and `useTranscriptScrollAnchor` backs it). The field is a
  // public instance property read at call time, so it is set once and always
  // sees the live ref value.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !autoFollowRef.current;
  }, [virtualizer, autoFollowRef]);

  // Pin the top visible row when the user has scrolled up and a tool body
  // above the viewport resizes (Tier 2). No-op while pinned to the bottom
  // (auto-follow owns that) or while paginating (dedicated restore owns that).
  useTranscriptScrollAnchor({
    scrollRef,
    virtualizer,
    autoFollowRef,
    totalSize,
    isLoadingOlder,
    isLoadingNewer,
  });

  return (
    <div class="transcript-virtual-wrap">
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
            aria-label="Jump to latest"
            title="Jump to latest"
            onClick={jumpToLatest}
          >
            <span aria-hidden="true">↓</span>
          </button>
        )}
      </div>
      <MessageRail
        rows={rows}
        virtualizer={virtualizer}
        scrollRef={scrollRef}
        setAutoFollow={setAutoFollow}
        hidden={isInitialPositioning}
      />
    </div>
  );
}
