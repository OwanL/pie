/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';

import { playCompletionSound } from '../completion-sound';
import { validateViewState } from '../state-validator';
import { clearCollapsibleCache } from '../transcript/use-collapsible-open';
import {
  clearLazyDetailCache,
  receiveLazyDetailResult,
  setLazyDetailPostMessage,
} from '../transcript/lazy-detail-store';

import type {
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  HostToWebviewMessage,
  ModelInfo,
  PruningCatalog,
  PruningSettings,
  SessionUsageSnapshot,
  ToolResultPruningSettings,
  ViewState,
  WebviewToHostMessage,
} from '../../../shared/protocol';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_TRANSCRIPT_WINDOW, WEBVIEW_PROTOCOL_VERSION } from '../../../shared/protocol';
import { EMPTY_AGGREGATE_STATS } from '../../../shared/protocol';
import { pickStable } from '../utils/view-state-stabilize';
import { pickStableModelList } from '../utils/model-list-stabilize';
import { webviewLog } from '../utils/log';
import type { TranscriptCommitTarget } from '../transcript/commit-registry';
import { recordRenderEvidenceTarget } from '../render-error';

export const EMPTY_VIEW_STATE: ViewState = {
  sessions: [],
  openTabPaths: [],
  pinnedTabPaths: [],
  pinnedTabGroups: [],
  runningSessionPaths: [],
  startingModelSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSession: null,
  transcript: [],
  transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
  sessionUsage: null,
  transcriptLoaded: false,
  draftText: '',
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  tokenRateBySession: {},
  aggregateStats: EMPTY_AGGREGATE_STATS,
  busy: false,
  retryStatus: null,
  liveTurnPhase: null,
  notice: null,
  noticeKind: null,
  backendReady: false,
  workspaceCwd: null,
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: { ...DEFAULT_CHAT_PREFS },
  availableExtensions: [],
  fileChanges: [],
  fileChangesExpanded: false,
  readFilePaths: [],
  pruningResult: null,
  pruningSettings: { ...DEFAULT_PRUNING_SETTINGS },
  toolResultPruningSettings: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules } },
  pruningCatalog: {
    skills: [],
    tools: [],
  },
  prepassPhase: 'idle',
  prepassStartedAt: null,
  prepassLatencyMs: undefined,
  editingMessageId: null,
  editingDraft: null,
  pendingExtensionUIRequestsBySession: {},
  pendingExtensionUIRequest: null,
};

/** An optimistic user message shown instantly before the host confirms it. */
export interface OptimisticUserMessage {
  localId: string;
  text: string;
  sessionPath: string;
}

export interface HostSyncState {
  viewState: ViewState;
  /** Transcript with optimistic user messages merged in. */
  mergedTranscript: ChatMessage[];
  /** Latest validated protocol-v4 envelope awaiting renderer evidence. */
  commitTarget: TranscriptCommitTarget | null;
  draftRestore: { text: string; nonce: number } | null;
  activeSessionPathRef: { current: string | null };
  setDraftRestore: (v: { text: string; nonce: number } | null) => void;
  /** Add an optimistic user message to be shown instantly. */
  addOptimisticMessage: (msg: OptimisticUserMessage) => void;
}

/* ------------------------------------------------------------------ */
//  Sub-hooks
/* ------------------------------------------------------------------ */

/**
 * Fill gaps in host-delivered state with safe defaults and log violations.
 * Prevents render crashes when the host omits newly-added nested fields.
 *
 * `prefs` / `pruningSettings` / `pruningCatalog` are reference-stabilised (small
 * JSON-like objects, via `pickStable`), and `availableModels` is stabilised via the
 * dedicated `pickStableModelList` (its nested `ModelInfo` elements defeat
 * `shallowConfigEqual`). The host re-serialises the whole `ViewState` on every
 * snapshot (fresh refs even when content is unchanged), which would otherwise
 * defeat every `memo()` / `useMemo` / `useCallback` barrier downstream (notably
 * `MessageItem = memo()`, the `Composer`/`BottomSection`/`VirtualRow` memo
 * boundaries, and `useTranscriptRenderToolCall`'s `useCallback([prefs, ...])`).
 * Reusing the previous reference when content is unchanged keeps those barriers
 * effective. `pickStable` / `pickStableModelList` compare content so a genuinely
 * different value (e.g. a pref toggle, a newly-added model) still produces a new
 * ref.
 *
 * Unlike the previous module-level singletons, the cached refs live inside this
 * hook so they are scoped to the component instance; this prevents leaks across
 * tests/webview reloads and eliminates order-dependence during hydration.
 */
function useHydrateViewState() {
  const stablePrefsRef = useRef<ChatPrefs | null>(null);
  const stablePruningSettingsRef = useRef<PruningSettings | null>(null);
  const stableToolResultPruningSettingsRef = useRef<ToolResultPruningSettings | null>(null);
  const stablePruningCatalogRef = useRef<PruningCatalog | null>(null);
  const stableSessionUsageRef = useRef<SessionUsageSnapshot | null>(null);
  /** Reference-stabilised `availableModels` (see `model-list-stabilize.ts`);
   *  seeded with `[]` to mirror `EMPTY_VIEW_STATE.availableModels`. */
  const stableAvailableModelsRef = useRef<ModelInfo[]>([]);

  return useCallback((raw: ViewState): ViewState => {
    validateViewState(raw);
    const prefs = pickStable(stablePrefsRef.current, { ...DEFAULT_CHAT_PREFS, ...raw.prefs });
    stablePrefsRef.current = prefs;
    const pruningSettings = pickStable(stablePruningSettingsRef.current, {
      ...DEFAULT_PRUNING_SETTINGS,
      ...raw.pruningSettings,
    });
    stablePruningSettingsRef.current = pruningSettings;
    // `rules` is deep-merged so a partial host snapshot (e.g. one missing the
    // `rules` key) doesn't drop toggle keys — defaults fill any absent toggle.
    const toolResultPruningSettings = pickStable(stableToolResultPruningSettingsRef.current, {
      ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      ...raw.toolResultPruningSettings,
      rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules, ...(raw.toolResultPruningSettings?.rules ?? {}) },
    });
    stableToolResultPruningSettingsRef.current = toolResultPruningSettings;
    const pruningCatalog = pickStable(stablePruningCatalogRef.current, {
      ...EMPTY_VIEW_STATE.pruningCatalog,
      ...raw.pruningCatalog,
    });
    stablePruningCatalogRef.current = pruningCatalog;
    // `availableModels` can be much larger than the small config objects above
    // and benefits from its purpose-built model signatures. Run it through the
    // dedicated stabilizer so downstream `useMemo` deps and `memo()` barriers
    // keyed on the `availableModels` ref (model-state, pricing-by-model-id,
    // Composer) hold across snapshots whose model list did not actually change.
    const availableModels = pickStableModelList(stableAvailableModelsRef.current, raw.availableModels);
    stableAvailableModelsRef.current = availableModels;
    // Whole-session accounting is a compact flat sample list, but structured
    // cloning still gives it a fresh reference on every streaming snapshot.
    // Stabilize it so cost calculation keeps its signature-gated O(1) path
    // instead of recursively re-walking loaded subagent results ~7 times/sec.
    const sessionUsage = raw.sessionUsage
      ? pickStable(stableSessionUsageRef.current, raw.sessionUsage)
      : null;
    stableSessionUsageRef.current = sessionUsage;
    return {
      ...raw,
      prefs,
      pruningSettings,
      toolResultPruningSettings,
      pruningCatalog,
      availableModels,
      sessionUsage,
    };
  }, []);
}

function useMergedTranscript(viewState: ViewState, optimisticMessages: OptimisticUserMessage[]): ChatMessage[] {
  return useMemo(() => {
    if (optimisticMessages.length === 0) {
      return viewState.transcript;
    }

    const activeSessionPath = viewState.activeSession?.path;
    if (!activeSessionPath) {
      return viewState.transcript;
    }

    const hostIds = new Set(viewState.transcript.map((m) => m.id));
    const pendingForSession = optimisticMessages.filter(
      (m) => m.sessionPath === activeSessionPath && !hostIds.has(m.localId),
    );

    if (pendingForSession.length === 0) {
      return viewState.transcript;
    }

    const now = new Date().toISOString();
    const chatMessages: ChatMessage[] = pendingForSession.map((m) => ({
      id: m.localId,
      role: 'user' as const,
      createdAt: now,
      markdown: m.text,
      status: 'completed' as const,
    }));

    return [...viewState.transcript, ...chatMessages];
  }, [viewState.transcript, viewState.activeSession?.path, optimisticMessages]);
}


function useFocusRefresh(postMessage: (msg: WebviewToHostMessage) => void) {
  useEffect(() => {
    let frame = 0;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    const refreshState = () => {
      if (document.hidden) return;
      const now = performance.now();
      // VS Code commonly emits visibilitychange and focus as one transition.
      // Collapse that pair (and focus chatter) so settings.get/models.list do
      // not repeat synchronous metadata checks back-to-back.
      if (now - lastRefreshAt < 500 || frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        lastRefreshAt = performance.now();
        postMessage({ type: 'refreshState' });
      });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) refreshState();
    };

    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('focus', refreshState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [postMessage]);
}

/* ------------------------------------------------------------------ */
//  Per-type message handlers
/* ------------------------------------------------------------------ */

interface OptimisticMessageOps {
  clear: () => void;
  reconcileWithHostIds: (hostIds: Set<string>) => void;
  removeByLocalId: (localId: string) => void;
  removeBySessionPath: (sessionPath: string) => void;
}

interface DraftRestoreOps {
  applyQueued: (sessionPath: string) => boolean;
  clearQueued: () => void;
  queueForSession: (sessionPath: string, text: string) => void;
  restoreNow: (text: string) => void;
}

/**
 * Immediate composer-input restore ops. When a `sendRejected` imperative
 * carries `inputs`, `restoreNow` stages them as a transient override of
 * `viewState.pendingComposerInputs` so the attachments reappear in the
 * composer instantly — without waiting for the debounced host snapshot
 * (which restores `pendingComposerInputsBySession` host-side in the same
 * reducer transition). The override is cleared on the next `state` message,
 * by which point the host snapshot carries the restored inputs (no flicker).
 */
interface InputsRestoreOps {
  restoreNow: (inputs: ComposerInput[]) => void;
  clear: () => void;
}

interface HostMessageContext {
  hydrateViewState: (raw: ViewState) => ViewState;
  resetPerSessionState: () => void;
  hostInstanceIdRef: { current: string };
  viewGenerationRef: { current: number };
  /** Last applied snapshot revision (Brief D). Allowlisted webview-local
   *  protocol-sync bookkeeping (STATE_CONTRACT § Webview-Local State). */
  lastRevisionRef: { current: number };
  activeSessionPathRef: { current: string | null };
  committedSessionPathRef: { current: string | null };
  clearTransientUi: () => void;
  optimisticOps: OptimisticMessageOps;
  draftOps: DraftRestoreOps;
  inputsOps: InputsRestoreOps;
  setViewState: (v: ViewState) => void;
  setCommitTarget: (v: TranscriptCommitTarget | null) => void;
  postMessage: (msg: WebviewToHostMessage) => void;
}

/** Tracks whether the webview has already warned about a host/webview
 * protocol mismatch, so the warning fires once rather than on every state
 * message. */
let warnedProtocolMismatch = false;

/**
 * Warn (once) when the host posts a webview-channel protocol version that does
 * not match this build's compiled-in expectation. The webview does not refuse
 * to load — it ships together with the host, so a mismatch generally indicates
 * a stale hot-reload rather than a genuine incompatibility.
 */
function warnOnProtocolMismatch(hostProtocolVersion: number): void {
  if (warnedProtocolMismatch) {
    return;
  }
  if (hostProtocolVersion !== WEBVIEW_PROTOCOL_VERSION) {
    warnedProtocolMismatch = true;
    webviewLog(
      'warn',
      'host-sync',
      `webview protocol mismatch: host posted version ${hostProtocolVersion} but this webview build expects ${WEBVIEW_PROTOCOL_VERSION}`,
      { note: 'This usually means a stale hot-reload — rebuild and reload both sides together.' },
    );
  }
}

function handleStateMessage(msg: HostToWebviewMessage, ctx: HostMessageContext) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'state' }>;
  warnOnProtocolMismatch(m.protocolVersion);

  // ── Brief D: revision guard (total) ──────────────────────────────────
  // Discard out-of-order / duplicate envelopes TOTALLY, before any state
  // mutation. Transport is snapshots-only; a delayed or re-posted envelope
  // whose revision is not strictly newer than the last applied one (for the
  // SAME host instance) is stale. Applying it would regress
  // viewState.transcript to older content while the optimistic overlay or
  // streaming state is still in flight — the "old + new message at once"
  // symptom (e.g. a delayed pre-send snapshot arriving after the confirm
  // snapshot would drop the just-sent message from the rendered transcript
  // while the overlay / React batch still held the optimistic copy).
  //
  // On a host-instance change the revision counter resets to 1, so rebase
  // `lastRevisionRef` to the incoming revision and accept — the clear below
  // wipes transient UI, so there is nothing stale to protect. (The first
  // snapshot after webview load also passes: lastRevisionRef starts at 0 and
  // host revisions are 1-based.)
  const prevHostInstanceId = ctx.hostInstanceIdRef.current;
  const hostChanged = !!prevHostInstanceId && m.hostInstanceId !== prevHostInstanceId;
  const generationChanged = ctx.viewGenerationRef.current !== 0 && m.viewGeneration !== ctx.viewGenerationRef.current;
  if (!hostChanged && m.viewGeneration < ctx.viewGenerationRef.current) return;
  if (!hostChanged && !generationChanged && m.revision <= ctx.lastRevisionRef.current) {
    return; // stale / duplicate — discard totally (no flicker, no overlay regression)
  }

  // Hydration validates the complete ViewState. Receipt evidence is emitted
  // only after this succeeds, and before scheduling any renderer state update.
  const hydratedState = ctx.hydrateViewState(m.state);
  ctx.lastRevisionRef.current = m.revision;
  ctx.viewGenerationRef.current = m.viewGeneration;
  const commitTarget: TranscriptCommitTarget = {
    revision: m.revision,
    viewGeneration: m.viewGeneration,
    expectedTranscriptIdentity: m.expectedTranscriptIdentity,
    acceptedAt: performance.now(),
    state: {
      transcript: m.state.transcript,
      transcriptWindow: m.state.transcriptWindow,
      activeSessionPath: m.state.activeSession?.path ?? null,
      openTabPaths: m.state.openTabPaths,
    },
  };
  recordRenderEvidenceTarget(commitTarget, 'app');
  ctx.postMessage({
    type: 'stateReceived',
    payload: {
      revision: m.revision,
      viewGeneration: m.viewGeneration,
      snapshotBytes: m.snapshotBytes,
    },
  });

  ctx.resetPerSessionState();
  const nextActiveSessionPath = m.state.activeSession?.path ?? null;
  const sessionChanged = ctx.committedSessionPathRef.current !== null && ctx.committedSessionPathRef.current !== nextActiveSessionPath;

  ctx.hostInstanceIdRef.current = m.hostInstanceId;
  ctx.activeSessionPathRef.current = nextActiveSessionPath;
  ctx.committedSessionPathRef.current = nextActiveSessionPath;

  if (hostChanged || sessionChanged) {
    if (hostChanged) {
      ctx.draftOps.clearQueued();
    }
    ctx.clearTransientUi();
    // The collapsible cache is keyed by globally-unique message/tool ids, so
    // it never goes stale across session switches. Clear it ONLY on a backend
    // restart (hostChanged), where the session data is genuinely new. Skipping
    // the clear on a plain session switch preserves the user's expand/collapse
    // state when switching back to a previously-viewed session and avoids a
    // re-resolve re-render of every visible collapsible per switch.
    if (hostChanged) {
      clearCollapsibleCache();
      clearLazyDetailCache();
    }
  } else {
    // Brief D length/identity guard: the optimistic overlay is reconciled
    // ONLY by localId identity — a confirmed host message (id === localId)
    // replaces its placeholder. The overlay is never shrunk by transcript
    // length or dropped by a stale snapshot: the revision guard above already
    // discarded the latter, and `reconcileWithHostIds` only removes entries
    // the host actually confirmed. A legitimate backend truncate shrinks the
    // transcript, but the host's `busy || hostRunning` preserve-decision
    // (session-handlers.ts / attach.ts) keeps the optimistic message in the
    // snapshot the webview receives, so this guard never blocks a shrink the
    // host already reconciled.
    const hostIds = new Set(m.state.transcript.map((msgItem) => msgItem.id));
    ctx.optimisticOps.reconcileWithHostIds(hostIds);
  }

  if (nextActiveSessionPath) {
    ctx.draftOps.applyQueued(nextActiveSessionPath);
  }

  // A post-rejection snapshot now carries the host-restored composer inputs
  // (the reducer restores `pendingComposerInputsBySession` in the same
  // transition that fires `sendRejected`), so the transient inputs override
  // has done its job — clear it so the authoritative snapshot takes over.
  ctx.inputsOps.clear();

  ctx.setViewState(hydratedState);
  ctx.setCommitTarget(commitTarget);
}

function handlePlayCompletionSound(msg: HostToWebviewMessage) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'playCompletionSound' }>;
  playCompletionSound(m.volume);
}

function handleSendRejectedMessage(
  msg: HostToWebviewMessage,
  ctx: Pick<HostMessageContext, 'optimisticOps' | 'draftOps' | 'inputsOps' | 'activeSessionPathRef'>,
) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'sendRejected' }>;
  if (m.localId) {
    ctx.optimisticOps.removeByLocalId(m.localId);
  } else {
    ctx.optimisticOps.removeBySessionPath(m.sessionPath);
  }

  // Restore pasted/dropped attachments to the composer immediately (no data
  // loss on rejection). The host also restores `pendingComposerInputsBySession`
  // in the same transition; this override bridges the debounced-snapshot gap so
  // the attachments reappear instantly. Cleared on the next `state` message.
  const targetsActiveSession = m.sessionPath === ctx.activeSessionPathRef.current;
  if (targetsActiveSession && m.inputs && m.inputs.length > 0) {
    ctx.inputsOps.restoreNow(m.inputs);
  }

  if (targetsActiveSession) {
    ctx.draftOps.restoreNow(m.text);
  } else {
    ctx.draftOps.queueForSession(m.sessionPath, m.text);
  }
}

type HostMessageHandler = (msg: HostToWebviewMessage, ctx: HostMessageContext) => void;

const HOST_MESSAGE_HANDLERS: Record<string, HostMessageHandler | undefined> = {
  state: handleStateMessage,
  playCompletionSound: (msg, _ctx) => handlePlayCompletionSound(msg),
  sendRejected: handleSendRejectedMessage,
};

export function dispatchHostMessage(msg: HostToWebviewMessage, ctx: HostMessageContext) {
  const handler = HOST_MESSAGE_HANDLERS[msg.type];
  if (handler) {
    handler(msg, ctx);
  }
}

/* ------------------------------------------------------------------ */
//  Main hook
/* ------------------------------------------------------------------ */

/**
 * Encapsulates protocol-sync and transport bookkeeping between the webview and
 * host. This state is webview-local per the STATE_CONTRACT allowlist.
 */
export function useHostSync(
  postMessage: (msg: WebviewToHostMessage) => void,
  initialState?: ViewState,
): HostSyncState {
  const [viewState, setViewState] = useState<ViewState>(initialState ?? EMPTY_VIEW_STATE);
  const [draftRestore, setDraftRestore] = useState<{ text: string; nonce: number } | null>(null);
  const [inputsRestore, setInputsRestore] = useState<{ inputs: ComposerInput[]; nonce: number } | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);
  const [commitTarget, setCommitTarget] = useState<TranscriptCommitTarget | null>(null);

  const hostInstanceIdRef = useRef('');
  // Brief D: last applied snapshot revision. Revisions are 1-based on the
  // host (globalRevision starts at 0, buildStateEnvelope does +1), so 0 means
  // "no snapshot applied yet" — the first envelope always passes the guard.
  const lastRevisionRef = useRef(0);
  const viewGenerationRef = useRef(0);
  const activeSessionPathRef = useRef<string | null>(null);
  const committedSessionPathRef = useRef<string | null>(null);
  const pendingDraftRestoreRef = useRef(new Map<string, { text: string }>());

  const hydrateViewState = useHydrateViewState();

  const clearTransientUi = useCallback(() => {
    setDraftRestore(null);
    setInputsRestore(null);
    setOptimisticMessages([]);
    // Background draft restorations are keyed by session and must survive a
    // same-host tab switch. `handleStateMessage` clears them explicitly only
    // when the host instance changes.
    // The collapsible cache is NOT cleared here. It is keyed by globally-unique
    // message/tool ids (`reasoning:<messageId>:<index>`, `tool:<toolCallId>`),
    // so it never goes stale across session switches — clearing it here would
    // only discard the user's expand/collapse state when switching back to a
    // previously-viewed session and force a re-resolve re-render of every
    // visible collapsible on each switch. It is cleared separately, only on a
    // backend restart (hostChanged), in `handleStateMessage`.
  }, []);

  const resetPerSessionState = useCallback(() => {
    // no-op: per-session revision tracking removed
  }, []);

  useEffect(() => {
    return () => resetPerSessionState();
  }, [resetPerSessionState]);

  const addOptimisticMessage = useCallback((msg: OptimisticUserMessage) => {
    setOptimisticMessages((prev) => [...prev, msg]);
  }, []);

  const mergedTranscript = useMergedTranscript(viewState, optimisticMessages);

  // When an active session's `sendRejected` carries inputs, stage them as a
  // transient override of `pendingComposerInputs` so its composer re-shows the
  // attachments.
  // instantly (the host restores `pendingComposerInputsBySession` in the same
  // reducer transition, but its snapshot is debounced). The override is cleared
  // on the next `state` message (`handleStateMessage`), by which point the host
  // snapshot carries the restored inputs — so the handoff is flicker-free
  // (both render the same inputs).

  const optimisticOpsRef = useRef<OptimisticMessageOps>({
    clear: () => setOptimisticMessages([]),
    reconcileWithHostIds: (hostIds) => {
      setOptimisticMessages((prev) => {
        if (prev.length === 0) return prev;
        const remaining = prev.filter((m) => !hostIds.has(m.localId));
        return remaining.length === prev.length ? prev : remaining;
      });
    },
    removeByLocalId: (localId) => {
      setOptimisticMessages((prev) => prev.filter((m) => m.localId !== localId));
    },
    removeBySessionPath: (sessionPath) => {
      setOptimisticMessages((prev) => prev.filter((m) => m.sessionPath !== sessionPath));
    },
  });

  const draftOpsRef = useRef<DraftRestoreOps>({
    applyQueued: (sessionPath) => {
      const queued = pendingDraftRestoreRef.current.get(sessionPath) ?? null;
      if (queued) {
        pendingDraftRestoreRef.current.delete(sessionPath);
        setDraftRestore({ text: queued.text, nonce: Date.now() });
        return true;
      }
      return false;
    },
    clearQueued: () => {
      pendingDraftRestoreRef.current.clear();
    },
    queueForSession: (sessionPath, text) => {
      pendingDraftRestoreRef.current.set(sessionPath, { text });
    },
    restoreNow: (text) => {
      setDraftRestore({ text, nonce: Date.now() });
    },
  });

  const inputsOpsRef = useRef<InputsRestoreOps>({
    restoreNow: (inputs) => {
      setInputsRestore({ inputs, nonce: Date.now() });
    },
    clear: () => {
      setInputsRestore(null);
    },
  });

  useEffect(() => {
    setLazyDetailPostMessage(postMessage);
    const handleMessage = (event: MessageEvent) => {
      // Guard against malformed messages from non-host sources (browser
      // extensions, devtools, etc.). The dispatchHostMessage handler
      // further validates the `type` field against known handlers.
      if (!event.data || typeof event.data.type !== 'string') return;
      if (event.data.type === 'detailResult' && event.data.result) {
        receiveLazyDetailResult(event.data.result);
        return;
      }
      dispatchHostMessage(event.data as HostToWebviewMessage, {
        hydrateViewState,
        resetPerSessionState,
        hostInstanceIdRef,
        viewGenerationRef,
        lastRevisionRef,
        activeSessionPathRef,
        committedSessionPathRef,
        clearTransientUi,
        optimisticOps: optimisticOpsRef.current,
        draftOps: draftOpsRef.current,
        inputsOps: inputsOpsRef.current,
        setViewState,
        setCommitTarget,
        postMessage,
      });
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    postMessage({ type: 'refreshState' });
    return () => window.removeEventListener('message', handleMessage);
  }, [clearTransientUi, postMessage, resetPerSessionState, hydrateViewState]);

  useFocusRefresh(postMessage);

  const effectiveViewState = useMemo<ViewState>(
    () => (inputsRestore ? { ...viewState, pendingComposerInputs: inputsRestore.inputs } : viewState),
    [viewState, inputsRestore],
  );

  return { viewState: effectiveViewState, mergedTranscript, commitTarget, draftRestore, activeSessionPathRef, setDraftRestore, addOptimisticMessage };
}
