/**
 * Pure projection: ArchState → ViewState
 *
 * Derives the webview-visible shape from the CQRS state tree. The derivation
 * (`projectViewState`) is pure and side-effect-free — no I/O, no `Date.now`,
 * no randomness (STATE_CONTRACT § Reducer Purity governs the reducer; the
 * same discipline is kept here). `selectViewState` wraps it in a
 * single-entry memoizing cache keyed by a cheap object-identity signature so
 * unchanged-delta posts (token-rate ticks, no-op events, background session
 * streaming) are O(1) amortized — see "Memoization" below.
 */

import type {
  ActiveRunSummary,
  ChatMessage,
  ComposerInput,
  ContextWindowUsage,
  DeferredTriggerView,
  FileChangeEntry,
  ModelInfo,
  PruningCatalog,
  PruningDetails,
  PruningResult,
  RetryStatus,
  SessionSummary,
  SystemPromptEntry,
  TranscriptWindow,
  ViewState,
} from '../../shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../../shared/protocol';
import { EMPTY_AGGREGATE_STATS } from '../../shared/protocol';
import { pruningTotals } from '../../shared/pruning.js';
import { redactSensitiveText } from '../../shared/sensitive-redaction.js';
import { projectTranscriptView } from './live-pipeline/projection.js';
import type {
  ArchState,
  ComposerState,
  FileChangesState,
  PendingOp,
  PrepassPhaseState,
  SessionsState,
  SettingsState,
} from './arch-state';

// ─── Empty sentinels (stable references keep downstream shallow-equals cheap) ─

const EMPTY_TRANSCRIPT: ChatMessage[] = [];
const EMPTY_SYSTEM_PROMPTS: SystemPromptEntry[] = [];
const EMPTY_AVAILABLE_MODELS: ModelInfo[] = [];
const EMPTY_COMPOSER_INPUTS: ComposerInput[] = [];
const EMPTY_FILE_CHANGES: FileChangeEntry[] = [];
const EMPTY_READ_PATHS: string[] = [];
const EMPTY_PRUNING_CATALOG: PruningCatalog = { skills: [], tools: [] };
const EMPTY_DEFERRED_TRIGGERS: readonly DeferredTriggerView[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sortUniqueNames(names: readonly string[]): string[] {
  return [...new Set(
    names
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )].sort((a, b) => a.localeCompare(b));
}

function selectActivePruningCatalog(
  activePath: string | null,
  analyticsFactorsBySession: Record<string, import('../../shared/protocol').SessionAnalyticsFactors | null>,
): PruningCatalog {
  if (!activePath) return EMPTY_PRUNING_CATALOG;
  const factors = analyticsFactorsBySession[activePath];
  if (!factors) return EMPTY_PRUNING_CATALOG;

  return {
    skills: sortUniqueNames(
      factors.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => skill.name),
    ),
    tools: sortUniqueNames(factors.selectedToolIds),
  };
}

/**
 * Derive a PruningResult summary from the most recent pruning-result custom
 * message in the transcript. Returns the latest pruning result regardless of
 * which turn it belongs to, so the banner stays visible between turns.
 */
export function derivePruningResult(transcript: ChatMessage[]): PruningResult | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.customType !== 'pruning-result') continue;

    const details = message.customDetails as PruningDetails | undefined;
    if (!details) continue;

    // Handle error case — details may lack includedSkills when there's an error
    if (details.prepassError) {
      return {
        skillsKept: 0,
        skillsTotal: 0,
        toolsKept: 0,
        toolsTotal: 0,
        tokensSaved: 0,
        hasSkillPruning: false,
        hasToolPruning: false,
        error: details.prepassError,
        details,
      };
    }

    if (!Array.isArray(details.includedSkills)) continue;

    const t = pruningTotals(details);

    return {
      skillsKept: t.skillsKept,
      skillsTotal: t.skillsTotal,
      toolsKept: t.toolsKept,
      toolsTotal: t.toolsTotal,
      tokensSaved: t.tokensSaved,
      hasSkillPruning: details.excludedSkills.length > 0,
      hasToolPruning: details.excludedTools.length > 0,
      details,
    };
  }
  return null;
}

// ─── Prepass status derivation (Brief F) ──────────────────────────────────────

/** Find the pre-commit op for a session in one pending table, if any.
 *  At most one non-queued op can execute per session because session mutations
 *  are serialized (STATE_CONTRACT § Execution Ordering). */
function findPreflightOpForSession(
  entries: Record<string, PendingOp>,
  sessionPath: string,
): PendingOp | undefined {
  for (const op of Object.values(entries)) {
    if (op.sessionPath === sessionPath && !op.queued) return op;
  }
  return undefined;
}

interface PrepassViewState {
  phase: 'idle' | 'running' | 'succeeded' | 'failed';
  startedAt: number | null;
  latencyMs: number | null | undefined;
}

/** Derive the live prepass status for the active session. Host-side (the
 *  webview stays passive per STATE_CONTRACT § Webview-Local State) and pure:
 *  `startedAt` comes from the owning op's `startedAt` (captured from the Send
 *  command timestamp — not a reducer wall-clock read).
 *
 *  Phase logic:
 *  - A pending or promoted preflight op exists → `running`, or `succeeded`
 *    once the explicit phase boundary landed. Including `pending.ops` covers
 *    synchronous hooks whose boundary crosses stdio before the RPC ack.
 *  - No owning op + tracked.phase === `failed` → `failed`.
 *  - Otherwise → `idle` (commit point `MessageStarted` cleared the entry). */
function derivePrepassStatus(state: ArchState, activePath: string | null): PrepassViewState {
  if (!activePath) return { phase: 'idle', startedAt: null, latencyMs: undefined };
  const ownerOp = findPreflightOpForSession(state.pending.promoted, activePath)
    ?? findPreflightOpForSession(state.pending.ops, activePath);
  const tracked = state.pending.prepassBySession[activePath];
  if (ownerOp) {
    return {
      phase: tracked?.phase === 'succeeded' ? 'succeeded' : 'running',
      startedAt: ownerOp.startedAt,
      latencyMs: tracked?.latencyMs ?? undefined,
    };
  }
  return {
    phase: tracked?.phase === 'failed' ? 'failed' : 'idle',
    startedAt: null,
    latencyMs: tracked?.latencyMs ?? undefined,
  };
}

// ─── Memoization ──────────────────────────────────────────────────────────────
//
// selectViewState is memoized with a single-entry cache keyed by a cheap
// object-identity signature of the ArchState slices the projection reads.
// Every reducer handler uses Immer `produce` (see core/reducer/*.ts), so
// structural sharing gives a valid revision signal: a slice's reference
// changes iff the reducer mutated that slice. Comparing the references of
// the slices the projection reads is therefore both cheap (O(1) pointer
// compares) and exact — a cache hit guarantees an identical ViewState, so the
// SAME reference (and the SAME slice references) can be returned.
//
// Active-session scoping: the signature captures the active session's
// transcript sub-references (bySession / windowBySession / systemPromptsBy /
// editingMessageIdBy) rather than the whole `transcript` slice, so a
// *background* session streaming while another is viewed does NOT bust the
// cache for the unchanged active view. That is what keeps unchanged-delta
// posts O(1) amortized under Brief D's higher post frequency.
//
// Purity: the cache is transparent memoization — selectViewState remains a
// pure function of its input (deterministic; same input ⇒ same output
// reference). STATE_CONTRACT § Reducer Purity governs the reducer; projection
// keeps the same discipline, which memoization preserves.

interface ProjectionSignature {
  activeSessionPath: string | null;
  transcriptLoaded: boolean;
  sessions: SessionsState;
  settings: SettingsState;
  composer: ComposerState;
  fileChanges: FileChangesState;
  activeTranscript: ChatMessage[];
  activeTranscriptWindow: TranscriptWindow;
  activeSystemPrompts: SystemPromptEntry[];
  activeEditingMessageId: string | null;
  activeLiveRevision: number;
  // ── Brief F ───────────────────────────────────────────────────────────────
  // `prepassPhase` / `prepassStartedAt` / `prepassLatencyMs` are derived from
  // the active session's pending/promoted op (`pending.ops` / `promoted`,
  // startedAt) and its prepass phase entry. The
  // backing references below bust the memoized cache iff the phase changes —
  // a missing entry would let a stale phase leak (G's seam comment warned of
  // exactly this), so the inputs are wired in explicitly.
  activePromotedOp: PendingOp | null;
  activePendingPreflightOp: PendingOp | null;
  activePrepassPhase: PrepassPhaseState | null;
}

function computeProjectionSignature(state: ArchState): ProjectionSignature {
  const activePath = state.sessions.activeSessionPath;
  const windowBySession = state.transcript.windowBySession;
  return {
    activeSessionPath: activePath,
    transcriptLoaded: activePath
      ? Object.prototype.hasOwnProperty.call(windowBySession, activePath)
      : false,
    sessions: state.sessions,
    settings: state.settings,
    composer: state.composer,
    fileChanges: state.fileChanges,
    activeTranscript: activePath
      ? state.transcript.bySession[activePath] ?? EMPTY_TRANSCRIPT
      : EMPTY_TRANSCRIPT,
    activeTranscriptWindow: activePath
      ? windowBySession[activePath] ?? EMPTY_TRANSCRIPT_WINDOW
      : EMPTY_TRANSCRIPT_WINDOW,
    activeSystemPrompts: activePath
      ? state.transcript.systemPromptsBySession[activePath] ?? EMPTY_SYSTEM_PROMPTS
      : EMPTY_SYSTEM_PROMPTS,
    activeEditingMessageId: activePath
      ? state.transcript.editingMessageIdBySession[activePath] ?? null
      : null,
    activeLiveRevision: activePath ? state.livePipeline.revisionBySession[activePath] ?? 0 : 0,
    activePromotedOp: activePath
      ? findPreflightOpForSession(state.pending.promoted, activePath) ?? null
      : null,
    activePendingPreflightOp: activePath
      ? findPreflightOpForSession(state.pending.ops, activePath) ?? null
      : null,
    activePrepassPhase: activePath
      ? state.pending.prepassBySession[activePath] ?? null
      : null,
  };
}

function signaturesEqual(a: ProjectionSignature, b: ProjectionSignature): boolean {
  return (
    a.activeSessionPath === b.activeSessionPath &&
    a.transcriptLoaded === b.transcriptLoaded &&
    a.sessions === b.sessions &&
    a.settings === b.settings &&
    a.composer === b.composer &&
    a.fileChanges === b.fileChanges &&
    a.activeTranscript === b.activeTranscript &&
    a.activeTranscriptWindow === b.activeTranscriptWindow &&
    a.activeSystemPrompts === b.activeSystemPrompts &&
    a.activeEditingMessageId === b.activeEditingMessageId &&
    a.activeLiveRevision === b.activeLiveRevision &&
    a.activePromotedOp === b.activePromotedOp &&
    a.activePendingPreflightOp === b.activePendingPreflightOp &&
    a.activePrepassPhase === b.activePrepassPhase
  );
}

let cachedSignature: ProjectionSignature | null = null;
let cachedViewState: ViewState | null = null;

// ─── Main projection ──────────────────────────────────────────────────────────

/**
 * Project the full CQRS `ArchState` into the `ViewState` consumed by the
 * webview. Pure and memoized: a second call with an unchanged signature
 * (same slice references) returns the SAME ViewState reference in O(1), so
 * unchanged-delta posts pay nothing. A signature change recomputes via
 * {@link projectViewState} with full structural sharing — unchanged slices
 * reuse their references, keeping the webview's `pickStable` / `memo`
 * barriers effective (see hydrateViewState).
 */
export function selectViewState(state: ArchState): ViewState {
  const signature = computeProjectionSignature(state);
  if (
    cachedViewState !== null &&
    cachedSignature !== null &&
    signaturesEqual(cachedSignature, signature)
  ) {
    return cachedViewState;
  }
  const viewState = projectViewState(state);
  cachedSignature = signature;
  cachedViewState = viewState;
  return viewState;
}

/**
 * Pure, un-memoized derivation of the ViewState from ArchState. Structural
 * sharing is inherent: pass-through fields reuse their ArchState references
 * and empty cases reuse the EMPTY_* sentinels, so callers that compare slice
 * references (e.g. the webview `pickStable` barrier) see stability across
 * recomputes that leave a slice untouched.
 */
function projectViewState(state: ArchState): ViewState {
  const { sessions, transcript, settings, composer, fileChanges } = state;
  const activePath = sessions.activeSessionPath;

  // ── Active session derived from path + list ──
  const activeSession: SessionSummary | null =
    activePath
      ? sessions.sessions.find((s) => s.path === activePath) ?? null
      : null;

  // ── Per-active-session lookups ──
  const activeTranscript: ChatMessage[] = activePath
    ? projectTranscriptView(
        transcript.bySession[activePath] ?? EMPTY_TRANSCRIPT,
        state.livePipeline,
        activePath,
      ).messages
    : EMPTY_TRANSCRIPT;

  const activeTranscriptWindow: TranscriptWindow =
    activePath ? transcript.windowBySession[activePath] ?? EMPTY_TRANSCRIPT_WINDOW : EMPTY_TRANSCRIPT_WINDOW;

  const activeSystemPrompts: SystemPromptEntry[] =
    activePath ? transcript.systemPromptsBySession[activePath] ?? EMPTY_SYSTEM_PROMPTS : EMPTY_SYSTEM_PROMPTS;

  const activeTranscriptLoaded: boolean =
    activePath ? Object.prototype.hasOwnProperty.call(transcript.windowBySession, activePath) : false;

  const activePendingComposerInputs: ComposerInput[] =
    activePath ? composer.pendingComposerInputsBySession[activePath] ?? EMPTY_COMPOSER_INPUTS : EMPTY_COMPOSER_INPUTS;

  const activeRunSummary: ActiveRunSummary | null =
    activePath ? composer.activeRunSummaryBySession[activePath] ?? null : null;

  const activeDraftText: string =
    activePath ? composer.draftTextBySession[activePath] ?? '' : '';

  const activeAvailableModels: ModelInfo[] =
    activePath ? settings.availableModelsBySession[activePath] ?? EMPTY_AVAILABLE_MODELS : EMPTY_AVAILABLE_MODELS;

  const activeContextUsage: ContextWindowUsage | null =
    activePath ? settings.contextUsageBySession[activePath] ?? null : null;

  const activeFileChanges: FileChangeEntry[] =
    activePath ? fileChanges.bySession[activePath] ?? EMPTY_FILE_CHANGES : EMPTY_FILE_CHANGES;

  const activeFileChangesExpanded: boolean =
    activePath ? fileChanges.expandedBySession[activePath] ?? false : false;

  const activeReadFilePaths: string[] =
    activePath ? fileChanges.readFilePathsBySession[activePath] ?? EMPTY_READ_PATHS : EMPTY_READ_PATHS;

  // ── Derived busy flag ──
  const busy = !!activePath && sessions.runningSessionPaths.includes(activePath);

  // ── 'Starting model' session paths (muted tab dot) ──
  // A running turn whose pruning prepass already succeeded but has not yet
  // committed (first MessageStarted) — the post-pruning, pre-streaming window
  // that includes concurrency-limit / rate-limit waits. `prepassBySession`
  // phase 'succeeded' is only set while a promoted (pre-commit) op exists and
  // is cleared at the commit point, so intersecting with runningSessionPaths is
  // belt-and-suspenders (a stale 'succeeded' on a non-running session shows no
  // dot anyway). The tab bar renders a muted dot for these.
  const startingModelSessionPaths = sessions.runningSessionPaths.filter(
    (path) => state.pending.prepassBySession[path]?.phase === 'succeeded',
  );

  // ── Live auto-retry status for the active session ──
  // Independent of `busy`: a retry sleeps between turns and the `willRetry`
  // gate on `agent_end` keeps `busy` true, but this is the authoritative
  // "a retry is in flight" signal the webview chips on (absent entry = null).
  const retryStatus: RetryStatus | null =
    activePath ? sessions.retryStatusBySession[activePath] ?? null : null;

  // ── Pruning projection ──
  const pruningResult = selectActivePruningResult(state);
  const pruningCatalog = selectActivePruningCatalog(activePath, sessions.analyticsFactorsBySession);
  // ── Prepass status (Brief F) — live, cancelable chip ──
  const prepass = derivePrepassStatus(state, activePath);

  return {
    sessions: sessions.sessions,
    openTabPaths: sessions.openTabPaths,
    pinnedTabPaths: sessions.pinnedTabPaths,
    runningSessionPaths: sessions.runningSessionPaths,
    startingModelSessionPaths,
    unreadFinishedSessionPaths: sessions.unreadFinishedSessionPaths,
    activeSession,
    transcript: activeTranscript,
    transcriptWindow: activeTranscriptWindow,
    transcriptLoaded: activeTranscriptLoaded,
    pendingComposerInputs: activePendingComposerInputs,
    activeRunSummary,
    runSummariesBySession: composer.activeRunSummaryBySession,
    // Placeholder: the live per-session rates are measured host-side by
    // `TokenRateService` and merged in by `PieExtension.buildViewState`
    // (this pure projection must not call the service).
    tokenRateBySession: {},
    // Placeholder: aggregate stats are computed host-side by
    // `AggregateStatsService` (reads run-analytics + pricing, ticks on a
    // timer) and merged in by `PieExtension.buildViewState`. The pure
    // projection must not read services or disk (STATE_CONTRACT § Reducer
    // Purity).
    aggregateStats: EMPTY_AGGREGATE_STATS,
    // Placeholder: active deferred triggers are read host-side from the
    // `DeferredTriggerRegistry` (owned by `SessionService`) and merged in by
    // `PieExtension.buildViewState`. The pure projection must not read services
    // (STATE_CONTRACT § Reducer Purity).
    deferredTriggers: EMPTY_DEFERRED_TRIGGERS as DeferredTriggerView[],
    draftText: activeDraftText,
    busy,
    retryStatus,
    liveTurnPhase: activePath ? state.livePipeline.turnsBySession[activePath]?.phase ?? null : null,
    notice: settings.notice,
    noticeKind: settings.noticeKind,
    noticeRaw: settings.noticeRaw === null ? null : redactSensitiveText(settings.noticeRaw),
    backendReady: settings.backendReady,
    workspaceCwd: sessions.workspaceCwd,
    systemPrompts: activeSystemPrompts,
    modelSettings: settings.modelSettings,
    availableModels: activeAvailableModels,
    contextUsage: activeContextUsage,
    prefs: settings.prefs,
    fileChanges: activeFileChanges,
    fileChangesExpanded: activeFileChangesExpanded,
    readFilePaths: activeReadFilePaths,
    availableExtensions: settings.availableExtensions,
    pruningResult,
    pruningSettings: settings.pruningSettings,
    toolResultPruningSettings: settings.toolResultPruningSettings,
    pruningCatalog,
    prepassPhase: prepass.phase,
    prepassStartedAt: prepass.startedAt,
    prepassLatencyMs: prepass.latencyMs,
    editingMessageId: activePath ? state.transcript.editingMessageIdBySession[activePath] ?? null : null,
    showOutcomeDialog: activePath ? state.settings.showOutcomeDialogBySession[activePath] ?? false : false,
    pendingExtensionUIRequestsBySession: settings.pendingExtensionUIRequestsBySession,
    pendingExtensionUIRequest: activePath
      ? (() => {
          const sessionMap = settings.pendingExtensionUIRequestsBySession[activePath];
          if (!sessionMap) return null;
          const requests = Object.values(sessionMap);
          // Preserve the bottom bar's existing priority for requests without
          // an inline owner. If every request is tool/subagent-owned, still
          // surface the oldest one as a fixed fallback. Inline transcript
          // rendering is not reliable enough to be the only answer surface:
          // the owning card can be collapsed, virtualized, delayed behind the
          // extension_ui event, or stale while the session tab already shows
          // its pending-question attention state.
          return requests.find((req) => !req.subagentCallId && !req.toolCallId)
            ?? requests[0]
            ?? null;
        })()
      : null,
  };
}

// ─── Pruning result selector (extracted for readability) ──────────────────────

function selectActivePruningResult(state: ArchState): PruningResult | null {
  if (!state.settings.prefs.showPruningMessages) return null;
  // Hide the pruning banner entirely when the skill-pruner extension is
  // disabled (either via the per-extension toggle or pruning mode = 'off').
  // Stale pruning-result messages from prior runs would otherwise persist.
  if (state.settings.prefs.extensionToggles['skill-pruner'] === false) return null;
  if (state.settings.pruningSettings.mode === 'off') return null;

  const activePath = state.sessions.activeSessionPath;
  const transcript: ChatMessage[] =
    activePath ? state.transcript.bySession[activePath] ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT;

  return derivePruningResult(transcript);
}
