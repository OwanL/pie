/**
 * Shared run-analytics contracts: the canonical type definitions for the
 * run-analytics schema exchanged between the extension host (producer) and the
 * analysis tree (consumer).
 *
 * Previously these types were duplicated across
 * `extension/src/host/run-analytics/types.ts` (producer, canonical) and
 * `analysis/scripts/contracts.ts` (consumer, stale mirror), with leaf
 * primitives scattered across `extension/src/shared/protocol/*.ts` and
 * `extension/src/shared/tool-call-analysis/verification.ts`. They are now
 * hoisted here as the single source of truth; both consumers re-export from
 * this module so existing import sites stay unchanged.
 *
 * The four kind unions (`ToolFailureKind`, `ToolResultIssueKind`,
 * `TreatmentChangeKind`, `VerificationCommandKind`) remain canonical in
 * `./tool-analysis-kinds.js` and are imported here, not redefined.
 *
 * This module is pure TypeScript (no Node- or browser-only APIs) and is
 * authored under `verbatimModuleSyntax` so it is portable to all consumers
 * (NodeNext native + bundler). Type-only symbols use `export type`.
 */

import type {
  ToolFailureKind,
  ToolResultIssueKind,
  TreatmentChangeKind,
  VerificationCommandKind,
} from './tool-analysis-kinds.js';

// ─── Leaf primitives ────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Per-assistant-message token usage. Mirrors the fields on the pi-ai `Usage`
 * object — kept optional so older messages (or aborted/errored ones) can omit
 * fields the provider didn't report.
 */
export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /**
   * Provider-reported reasoning/thinking tokens, when the provider breaks them
   * out. A SUBSET of `outputTokens` — never added to totals or cost separately
   * (pricing already covers them via `outputTokens`). Surfaced only so the UI
   * can show how much of the output was hidden reasoning. Undefined when the
   * provider did not report a reasoning breakdown; clamped to `outputTokens`
   * at extraction so it can never exceed it.
   */
  reasoningTokens?: number;
}

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';

export type PruningMode = 'auto' | 'shadow' | 'off' | 'custom';

export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';
export type RunOutcomeSource = 'user' | 'agent';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  /** Intended to be a user-facing ordinal score (e.g. 1–5). */
  satisfaction: number;
  /** Who supplied the outcome. Absent denotes a user-authored outcome for wire compatibility. */
  source?: RunOutcomeSource;
}

/** The kind of composer input attached to a user send; equal to `ComposerInput['kind']` in the extension protocol. */
export type InputKind = 'filesystemPathRef' | 'imageBlob' | 'fileBlob';

// ─── Session analytics factors ──────────────────────────────────────────────

export interface SessionContextFileFactor {
  path: string;
  hash: string;
}

export interface SessionToolSnippetFactor {
  toolId: string;
  hash: string;
}

export interface SessionSkillFactor {
  name: string;
  contentHash: string | null;
  sourceHash: string | null;
  disableModelInvocation: boolean;
  lastModifiedAt: string | null;
}

export interface SessionAnalyticsFactors {
  promptFamily: string | null;
  promptHash: string | null;
  /** ISO timestamp when the prompt factors were captured (session open time). */
  promptCapturedAt: string | null;
  harnessPromptHash: string | null;
  customPromptHash: string | null;
  appendSystemPromptHash: string | null;
  promptGuidelineHashes: string[];
  contextFiles: SessionContextFileFactor[];
  selectedToolIds: string[];
  toolSnippetHashes: SessionToolSnippetFactor[];
  toolSetHash: string | null;
  skills: SessionSkillFactor[];
  skillSetHash: string | null;
  /** Names of extensions active during this run (e.g. 'subagent', 'safeguard'). */
  activeExtensions: string[];
}

// ─── Subagent task scoring ──────────────────────────────────────────────────

export interface SubagentTaskScoreRollup {
  precision:    { sum: number; count: number; max: number };
  creativity:   { sum: number; count: number; max: number };
  reasoning:    { sum: number; count: number; max: number };
  thoroughness: { sum: number; count: number; max: number };
}

// ─── Run-analytics snapshot types ───────────────────────────────────────────

export type TaskBoundaryIntent = 'new_task' | 'continue_task' | null;
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';

export interface ToolFailureSample {
  toolName: string;
  failureKind: ToolFailureKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
  occurredAt: string;
}

export interface ToolResultIssueSample {
  toolName: string;
  /** Non-success result kind: a verification command that exposed project failures, or an empty probe/search. */
  resultIssueKind: ToolResultIssueKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
  occurredAt: string;
}

/**
 * Terminal status of a single assistant turn, mirrored on throughput samples
 * so rate-limit / failure signals can be graphed alongside generation speed.
 */
export type TurnThroughputStatus = 'completed' | 'error' | 'interrupted';

/**
 * One timestamped throughput observation per assistant turn.
 *
 * Throughput = `outputTokens` ÷ (`generationDurationMs` / 1000) — an
 * *effective response throughput*, not an isolated token-emission rate.
 * `generationDurationMs` is the wall-clock span from `message_start` to
 * `message_end` (the full assistant response): it EXCLUDES tool-execution
 * time (tools run between messages) but INCLUDES the initial wait for the
 * first token (time-to-first-token) and any hidden-reasoning generation the
 * provider performs within that span. TTFT is intentionally NOT subtracted:
 * for hidden-reasoning models the `message_start`→`message_end` interval
 * mixes unsurfaced token generation with visible emission and cannot be
 * decomposed, so reported-output ÷ full-duration is the faithful effective
 * throughput the user experienced.
 *
 * `concurrentBusySessions` records how many sessions were mid-run when the
 * turn ended (including this one), enabling multi-session throughput /
 * rate-limit-resilience analysis.
 *
 * `turnLatencyMs` / `overheadMs` / `providerLatencyMs` decompose the gap
 * between the previous tool call finishing and the model's first reply token
 * (null when not measurable for a given turn — e.g. `turn_start` was not
 * observed, or the turn produced no content delta). `turnLatencyMs` ≈
 * `overheadMs` + `providerLatencyMs`; the split is anchored on the SDK's
 * `turn_start` event: overhead = turn boundary → `turn_start` (serial
 * inter-turn work on our side), provider = `turn_start` → first reply token
 * (request preparation + network + provider TTFT).
 */
export interface TurnThroughputSample {
  /** ISO timestamp when the assistant turn ended (`message_end`). */
  endedAt: string;
  /** Output tokens reported for this turn (0 when the provider did not report usage). */
  outputTokens: number;
  /** Full assistant response duration for this turn in ms (message_start→message_end; includes TTFT and hidden reasoning, excludes tool execution). */
  generationDurationMs: number;
  /** Sessions concurrently mid-run when this turn ended, including this one. */
  concurrentBusySessions: number;
  /** Terminal status of the turn. */
  status: TurnThroughputStatus;
  /** The model this turn ran on. Used for per-sample provider attribution; absent ⇒ fall back to the run's model. */
  modelId?: string;
  /**
   * Total turn latency: previous tool end (or prompt send) → first reply
   * token, in ms. Null when not measurable for this turn.
   */
  turnLatencyMs: number | null;
  /**
   * Our overhead: turn boundary → `turn_start` (serial inter-turn work), in ms.
   * Null when `turn_start` was not observed.
   */
  overheadMs: number | null;
  /**
   * Provider latency: `turn_start` → first reply token (request prep + network
   * + provider TTFT), in ms. Null when not measurable.
   */
  providerLatencyMs: number | null;
  /**
   * Input tokens reported for this turn (0 when the provider did not report
   * usage). Optional on the wire so older samples (recorded before per-turn
   * input/cache breakdown existed) coerce cleanly; 0 = unreported.
   */
  inputTokens?: number;
  /**
   * Cache-read tokens reported for this turn (0 when unreported). Optional on
   * the wire; 0 = unreported.
   */
  cacheReadTokens?: number;
  /**
   * Cache-write tokens reported for this turn (0 when unreported). Optional on
   * the wire; 0 = unreported.
   */
  cacheWriteTokens?: number;
  /**
   * Context-window token count at the end of this turn (the run's current
   * `contextTokens`), or null when not tracked for this turn. Optional on the
   * wire; null = unreported. Backs the context-growth trajectory per turn.
   */
  contextTokens?: number | null;
}

export type AuxiliaryLlmUsageKind = 'skill_pruning_prepass' | 'subagent';

/**
 * Timestamped usage from an LLM call that is not one of the parent session's
 * assistant turns. Subagent samples duplicate the canonical totals in
 * `ToolUsageRollup.subagent*Tokens`; they preserve model/time attribution and
 * must not be added independently without reconciling against those totals.
 */
export interface AuxiliaryLlmUsageSample {
  kind: AuxiliaryLlmUsageKind;
  /** Stable source event id used to make repeated backend delivery idempotent. */
  sourceId: string;
  occurredAt: string;
  /** Actual model used when reported; consumers fall back to the run model. */
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolUsageRollup {
  totalCount: number;
  /**
   * Execution failures only: tool calls where the tool could not complete its
   * job (timeout, invalid arguments, missing file, shell error, nonzero exit on
   * a non-verification command, ...). Non-success results (failing tests/builds,
   * empty searches) are tracked under `resultIssueCount`, not here.
   */
  failureCount: number;
  /** Failed tool calls excluding verification-project failures and probe/no-match outcomes. */
  executionFailureCount: number;
  /** Failed tool calls where the command was verification and exposed project failures. */
  verificationProjectFailureCount: number;
  /** Failed probe/search commands that likely mean "no matches" rather than a broken tool. */
  probeFailureCount: number;
  /** Non-success results: tool ran to completion but reported a non-success outcome (verification failure or empty probe). */
  resultIssueCount: number;
  countsByName: Record<string, number>;
  failureCountsByName: Record<string, number>;
  failureCountsByKind: Record<ToolFailureKind, number>;
  failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>>;
  failureSamples: ToolFailureSample[];
  resultIssueCountsByName: Record<string, number>;
  resultIssueCountsByKind: Record<ToolResultIssueKind, number>;
  resultIssueCountsByNameAndKind: Record<string, Record<ToolResultIssueKind, number>>;
  resultIssueSamples: ToolResultIssueSample[];
  /** Cumulative wall-clock execution time (ms) across all timed tool calls. */
  totalDurationMs: number;
  /** Number of completed/failed tool calls that reported an execution duration. */
  timedCallCount: number;
  /** Cumulative execution time (ms) per normalized tool name. */
  durationMsByName: Record<string, number>;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  subagentScoredTaskCount: number;
  subagentTaskScores: SubagentTaskScoreRollup;
  /**
   * Cumulative input tokens consumed by spawned sub-agent sessions (rolled up
   * from each subagent result's `usage`). Default 0 for runs recorded before
   * subagent token attribution existed.
   */
  subagentInputTokens: number;
  /**
   * Cumulative output tokens consumed by spawned sub-agent sessions. Default 0.
   */
  subagentOutputTokens: number;
  /**
   * Cumulative cache-read tokens consumed by spawned sub-agent sessions. Default 0. */
  subagentCacheReadTokens: number;
  /**
   * Cumulative cache-write tokens consumed by spawned sub-agent sessions. Default 0. */
  subagentCacheWriteTokens: number;
}

export interface FileMutationRollup {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
  /** Per-file EDIT counts keyed by a path hash. Backs the file-churn signal (re-editing the same
   *  file repeatedly). Edits only; empty for runs captured before this field existed. */
  editCountsByFile: Record<string, number>;
  /** Per-file READ counts keyed by a path hash. Backs the "files reviewed" breadth signal (how many
   *  distinct files the agent reviewed) and the re-read churn signal (re-opening the same file).
   *  Reads only; empty for runs captured before this field existed or when no read had an
   *  extractable path. */
  readCountsByFile: Record<string, number>;
}

export interface FileExtensionRollup {
  readCountsByExtension: Record<string, number>;
  writeCountsByExtension: Record<string, number>;
  editCountsByExtension: Record<string, number>;
}

export interface VerificationRollup {
  totalCount: number;
  failureCount: number;
  countsByKind: Record<VerificationCommandKind, number>;
}

/**
 * Snapshot of the functional (behavioral) settings in effect when a run started.
 * Captured once at run start from `ArchState.settings` so outcomes can be
 * compared across setting values (e.g. sub-agent parent-model toggle, pruning
 * mode, per-extension enable/disable toggles). Mirrored on the analysis side.
 *
 * Intentionally a small, low-cardinality set of toggles — the dimensions most
 * useful for A/B-style graphing. Additive/optional on `RunSnapshot`: historical
 * runs recorded before this field existed coerce to `null` ("untracked").
 */
export interface FunctionalSettingsSnapshot {
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  /** Pruning mode at run start. */
  pruningMode: PruningMode;
  /** Per-extension enabled/disabled toggles at run start (extension id -> enabled). */
  extensionToggles: Record<string, boolean>;
  /** Tool-result-pruning enabled flag at run start (null = untracked, predates field). Backs the
   *  outcome comparison: are runs better with tool-result pruning on or off? */
  toolResultPruningEnabled: boolean | null;
  /** Tool-result-pruning profile at run start (null = untracked). */
  toolResultPruningProfile: 'default' | 'security' | null;
}

export interface RunSnapshot {
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  status: ActiveRunStatus;
  scored: boolean;
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizationReason?: RunFinalizationReason;
  outcome?: RunOutcome;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  mixedModelConfig: boolean;
  mixedTreatmentConfig: boolean;
  treatmentChangeKinds: TreatmentChangeKind[];
  experimentAssignment: string | null;
  analyticsFactors: SessionAnalyticsFactors | null;
  /** Functional settings snapshot captured at run start; null for runs recorded before tracking existed. */
  functionalSettings: FunctionalSettingsSnapshot | null;
  /** Privacy-safe size of the user-authored message that started this run, in Unicode code points. Optional for historical snapshots; content is never stored here. */
  initialUserMessageChars?: number;
  sendCount: number;
  assistantTurnCount: number;
  assistantTurnDurationMs: number;
  busyDurationMs: number;
  busyPeriodCount: number;
  interruptedCount: number;
  messageEditCount: number;
  truncatedAfterCount: number;
  /**
   * Number of history-compaction (`/compact`) LLM calls in this run. Compaction
   * is a billable LLM call that emits no `message_start`/`message_end`, so its
   * tokens are absent from the run totals — this count is the only available
   * compaction signal. Optional on the wire (default 0) for runs recorded before
   * the counter existed.
   */
  compactionCount?: number;
  /**
   * Number of auto-retry attempts (transient provider errors retried by the
   * SDK with backoff) in this run. Optional on the wire (default 0) for runs
   * recorded before the counter existed.
   */
  autoRetryCount?: number;
  backendErrorCodes: string[];
  contextTokens: number | null;
  contextLimit: number | null;
  /** Cumulative input tokens reported by the provider across assistant turns in this run. */
  inputTokens: number;
  /** Cumulative output tokens reported by the provider across assistant turns in this run. */
  outputTokens: number;
  /** Cumulative cache-read tokens across assistant turns in this run. */
  cacheReadTokens: number;
  /** Cumulative cache-write tokens across assistant turns in this run. */
  cacheWriteTokens: number;
  /**
   * Usage from billable LLM calls outside the parent assistant-turn stream.
   * Optional on the wire for historical snapshots. Skill-pruning samples are
   * canonical usage; subagent samples provide attribution for the canonical
   * `toolUsage.subagent*Tokens` totals and are not additional usage.
   */
  auxiliaryLlmUsage?: AuxiliaryLlmUsageSample[];
  /** Number of assistant turns in this run that reported provider usage. */
  tokenReportedTurnCount: number;
  /** Usage from the most recent assistant turn in this run that reported it. */
  lastTurnUsage: AssistantUsage | null;
  /**
   * Per-turn throughput observations (one timestamped sample per assistant
   * turn). Empty for runs recorded before throughput sampling existed.
   */
  turnThroughputSamples: TurnThroughputSample[];
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: InputKind[];
  toolUsage: ToolUsageRollup;
  fileMutation: FileMutationRollup;
  fileExtensions: FileExtensionRollup;
  verification: VerificationRollup;
}

/** Schema version stamped on every persisted run-analytics artifact. */
export const RUN_ANALYTICS_SCHEMA_VERSION = 1;
