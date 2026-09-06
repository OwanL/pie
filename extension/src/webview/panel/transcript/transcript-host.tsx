/** @jsxRuntime automatic */
/** @jsxImportSource preact */

/**
 * TranscriptHost renders a single TranscriptSurface for the active session
 * path only. Switching tabs preserves the host and surface, while the keyed
 * session-owned TranscriptView remounts so its virtualizer can start at the
 * bottom immediately instead of first mounting the previous tab's range.
 */

import type {
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  InlineEditDraft,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { TranscriptContextMenuHandler, TranscriptVirtualListProps } from './types';
import { TranscriptView } from '.';
import { buildTranscriptRows } from './virtual-list-rows';
import {
  decideTranscriptCommit,
  useCommittedAppSurface,
  useTranscriptCommitRegistry,
} from './commit-registry';
import { recordRenderEvidenceTarget } from '../render-error';

interface TranscriptSurfaceProps extends TranscriptVirtualListProps {
  sessionPath: string;
  isActive: boolean;
}

const TranscriptSurface = memo(function TranscriptSurface({
  sessionPath,
  isActive,
  sessionKey,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  loadingStatus,
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
}: TranscriptSurfaceProps) {
  const style = isActive
    ? 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column;visibility:visible;z-index:0;pointer-events:auto'
    : 'visibility:hidden;position:absolute;inset:0;z-index:-1;pointer-events:none;display:flex;flex-direction:column';

  return (
    <div
      class="transcript-surface"
      style={style}
      aria-hidden={!isActive}
      data-session-path={sessionPath}
    >
      <TranscriptView
        key={sessionKey ?? sessionPath}
        sessionKey={sessionKey}
        transcript={transcript}
        transcriptWindow={transcriptWindow}
        transcriptLoaded={transcriptLoaded}
        loadingStatus={loadingStatus}
        busy={busy}
        compacting={compacting}
        liveTurnPhase={liveTurnPhase}
        prefs={prefs}
        pruningSettings={pruningSettings}
        systemPrompts={systemPrompts}
        pruningResult={pruningResult}
        pendingAssistantModelId={pendingAssistantModelId}
        pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
        workingDirectory={workingDirectory}
        editingId={editingId}
        editingDraft={editingDraft}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        onLoadOlder={onLoadOlder}
        onLoadNewer={onLoadNewer}
        onJumpToLatest={onJumpToLatest}
        onCancelPrepass={onCancelPrepass}
      />
    </div>
  );
});

export interface TranscriptHostProps {
  openTabPaths: string[];
  activeSessionPath: string | null;
  // For now, these are shared from the active session's viewState.
  // Per-tab data will come from session stores in later phases.
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  transcriptLoaded: boolean;
  loadingStatus?: string;
  busy: boolean;
  compacting?: boolean;
  liveTurnPhase?: TranscriptVirtualListProps['liveTurnPhase'];
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  editingDraft?: InlineEditDraft | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[], queued?: boolean) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  postMessage: (msg: any) => void;
  /** Cancel the in-flight pruning prepass from within the agent reply. */
  onCancelPrepass?: () => void;
  /** Optional session key; falls back to activeSessionPath when omitted. */
  sessionKey?: string | null;
}

export function intentionallyOmittedPruningMessageIds(
  transcript: readonly ChatMessage[],
  rowIndexByMessageId: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  return new Set(
    transcript
      .filter((message) => message.customType === 'pruning-result' && !rowIndexByMessageId.has(message.id))
      .map((message) => message.id),
  );
}

export function TranscriptHost({
  openTabPaths,
  activeSessionPath,
  sessionKey,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  loadingStatus,
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
  onCancelPrepass,
  postMessage,
}: TranscriptHostProps) {
  const commitRegistry = useTranscriptCommitRegistry();
  const [mountGeneration, setMountGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const lastCommitRef = useRef<{ target: typeof commitRegistry.target; mountGeneration: number } | null>(null);
  const lastBlockedRef = useRef('');
  const paintFrameRef = useRef<number | null>(null);
  useCommittedAppSurface('transcript');

  useLayoutEffect(() => {
    const generation = commitRegistry.mountHost();
    setMountGeneration(generation);
    return () => commitRegistry.unmountHost(generation);
  }, [commitRegistry.mountHost, commitRegistry.unmountHost]);

  const commitRows = useMemo(() => buildTranscriptRows({
    transcript,
    systemPromptCount: systemPrompts.length,
    hasOlder: transcriptWindow.hasOlder,
    hasNewer: transcriptWindow.hasNewer,
    olderCount: transcriptWindow.loadedStart,
    newerCount: Math.max(0, transcriptWindow.totalCount - transcriptWindow.loadedEnd),
    busy,
    showPruningMessages: prefs.showPruningMessages,
  }), [transcript, systemPrompts.length, transcriptWindow.hasOlder, transcriptWindow.hasNewer, transcriptWindow.loadedStart, transcriptWindow.loadedEnd, transcriptWindow.totalCount, busy, prefs.showPruningMessages]);
  const rowIndexByMessageId = useMemo(() => {
    const result = new Map<string, number>();
    for (let index = 0; index < commitRows.length && index < 256; index += 1) {
      const row = commitRows[index];
      if (row?.kind === 'message') result.set(row.message.id, index);
    }
    return result;
  }, [commitRows]);
  // Structured pruning-result source rows may be deliberately omitted in two
  // cases: hidden by preference, or folded into the owning assistant header.
  // Derive the proof from the actual row model rather than the preference so a
  // folded source row in the signed tail does not wait forever for a DOM leaf
  // that the renderer intentionally never creates.
  const intentionallyHiddenMessageIds = useMemo(
    () => intentionallyOmittedPruningMessageIds(transcript, rowIndexByMessageId),
    [transcript, rowIndexByMessageId],
  );

  useLayoutEffect(() => {
    const target = commitRegistry.target;
    if (!target) return;
    // Leaf effects and the streamed-markdown buffer settle just after this
    // parent layout effect. Reporting that expected intermediate frame made
    // every streaming snapshot look like a warning even though the same
    // revision committed moments later. Only report a block that survives a
    // short, stable-target grace period; the cleanup cancels stale revisions.
    const reportBlocked = (reason: 'window_mismatch' | 'structure_mismatch' | 'leaf_missing' | 'leaf_mismatch') => {
      const blockedKey = `${target.viewGeneration}:${target.revision}:${reason}`;
      if (lastBlockedRef.current === blockedKey) return undefined;
      const timer = window.setTimeout(() => {
        lastBlockedRef.current = blockedKey;
        postMessage({
          type: 'transcriptCommitBlocked',
          payload: { revision: target.revision, viewGeneration: target.viewGeneration, reason },
        });
      }, 250);
      return () => window.clearTimeout(timer);
    };
    if (mountGeneration === 0 || !hostRef.current) {
      return reportBlocked('leaf_missing');
    }
    // Transcript evidence is a point-in-time acknowledgement, not a permanent
    // constraint on later webview-local UI. In particular, adding an immediate
    // optimistic row or switching the optimistic active tab after a target
    // committed changes the rendered structure before the host's confirming
    // snapshot arrives. Re-validating the already-settled target then emitted
    // spurious structure_mismatch warnings; repeated interactions could feed
    // the recovery watchdog even though Chromium had already proven that
    // revision. New authoritative state always carries a new revision and still
    // goes through the full validation below.
    // Snapshot targets are immutable. Compare the actual target so a fresh
    // renderer ledger with the same revision/identity still receives evidence.
    if (lastCommitRef.current?.target === target && lastCommitRef.current.mountGeneration === mountGeneration) return;

    if (target.state.activeSessionPath !== activeSessionPath
      || (activeSessionPath !== null && !target.state.openTabPaths.includes(activeSessionPath))) {
      return reportBlocked('structure_mismatch');
    }

    const mountedVirtualRowIndexes: number[] = [];
    const rowElements = hostRef.current.querySelectorAll<HTMLElement>('.transcript-virtual-inner > [data-index]');
    for (let index = 0; index < rowElements.length && index < 256; index += 1) {
      const value = Number(rowElements[index]?.dataset.index);
      if (Number.isSafeInteger(value) && value >= 0) mountedVirtualRowIndexes.push(value);
    }
    const decision = decideTranscriptCommit(target, commitRegistry.leaves, {
      renderedTranscript: transcript,
      window: transcriptWindow,
      mountedVirtualRowIndexes,
      rowIndexByMessageId,
      intentionallyHiddenMessageIds,
    });
    if (!decision.matches) {
      return reportBlocked(decision.reason ?? 'leaf_mismatch');
    }

    lastCommitRef.current = { target, mountGeneration };
    recordRenderEvidenceTarget(target, 'transcript');
    const payload = {
      revision: target.revision,
      viewGeneration: target.viewGeneration,
      identity: target.expectedTranscriptIdentity,
      mountGeneration,
      evidence: decision.evidence,
    } as const;
    postMessage({ type: 'transcriptCommitted', payload });

    if (paintFrameRef.current !== null) cancelAnimationFrame(paintFrameRef.current);
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = null;
      // The target may have advanced before this frame; stale paint evidence is
      // intentionally suppressed rather than attributed to the newer view.
      if (commitRegistry.target !== target) return;
      postMessage({
        type: 'paintObserved',
        payload: {
          ...payload,
          latencyMs: Math.max(0, performance.now() - target.acceptedAt),
        },
      });
    });
  }, [commitRegistry.target, commitRegistry.version, mountGeneration, activeSessionPath, transcript, transcriptWindow, rowIndexByMessageId, intentionallyHiddenMessageIds, postMessage]);

  useLayoutEffect(() => () => {
    if (paintFrameRef.current !== null) cancelAnimationFrame(paintFrameRef.current);
  }, []);

  // Wrap the callbacks from the parent with postMessage so they carry
  // the active session path as part of the control message.
  const loadOlder = useCallback(() => postMessage({
    type: 'loadOlderTranscript',
    sessionPath: activeSessionPath,
  }), [postMessage, activeSessionPath]);
  const loadNewer = useCallback(() => postMessage({
    type: 'loadNewerTranscript',
    sessionPath: activeSessionPath,
  }), [postMessage, activeSessionPath]);
  const jumpToLatest = useCallback(() => postMessage({
    type: 'jumpToLatestTranscript',
    sessionPath: activeSessionPath,
  }), [postMessage, activeSessionPath]);

  return (
    <div
      class="transcript-host"
      ref={hostRef}
      data-mount-generation={mountGeneration || undefined}
      style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column"
    >
      {activeSessionPath && openTabPaths.includes(activeSessionPath) && (
        <TranscriptSurface
          sessionPath={activeSessionPath}
          isActive
          sessionKey={sessionKey ?? activeSessionPath}
          transcript={transcript}
          transcriptWindow={transcriptWindow}
          transcriptLoaded={transcriptLoaded}
          loadingStatus={loadingStatus}
          busy={busy}
          compacting={compacting}
          liveTurnPhase={liveTurnPhase}
          prefs={prefs}
          pruningSettings={pruningSettings}
          systemPrompts={systemPrompts}
          pruningResult={pruningResult}
          pendingAssistantModelId={pendingAssistantModelId}
          pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
          workingDirectory={workingDirectory}
          editingId={editingId}
          editingDraft={editingDraft}
          onEditRequest={onEditRequest}
          onEditConfirm={onEditConfirm}
          onEditCancel={onEditCancel}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onJumpToLatest={jumpToLatest}
          onCancelPrepass={onCancelPrepass}
        />
      )}
    </div>
  );
}
