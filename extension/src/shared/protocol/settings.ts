import type { ThinkingLevel } from './models.js';
import type { TranscriptWindow } from './sessions.js';

/** Webview-local UI preferences. Owned by the host so they survive teardown. */
/** Metadata describing a known pi extension (tool or hook). */
export interface ExtensionInfo {
  /** Machine-readable extension name (e.g. 'subagent', 'safeguard'). */
  id: string;
  /** Human-readable label shown in the settings UI. */
  label: string;
  /** Short description of what the extension does. */
  description: string;
}

/** Parsed pruning result emitted by the skill-pruner extension. */
export interface PruningResult {
  skillsKept: number;
  skillsTotal: number;
  toolsKept: number;
  toolsTotal: number;
  tokensSaved: number;
  hasSkillPruning: boolean;
  hasToolPruning: boolean;
  /** Legacy convenience aliases retained for older settings/menu call sites. */
  includedSkills?: string[];
  excludedSkills?: string[];
  includedTools?: string[];
  excludedTools?: string[];
  /** Error message if the pruning prepass failed. */
  error?: string;
  /** Full pruning details for expanded view in the banner. */
  details?: PruningDetails;
}

/** Rich details from skill-pruner's pruning-result custom message. */
export interface PruningDetails {
  includedSkills: string[];
  excludedSkills: string[];
  includedTools: string[];
  excludedTools: string[];
  mode: PruningMode;
  skillTokensSaved: number;
  toolTokensSaved: number;
  /** Model used for the prepass LLM call. */
  prepassModel?: string;
  /** Thinking level of the prepass call. */
  prepassThinkingLevel?: string;
  /** User prompt sent to the pruning prepass model. */
  prepassUserMessage?: string;
  /** Reasoning text returned by the pruning prepass model. */
  prepassThinking?: string;
  /** Raw LLM response text (the reasoning/JSON output). */
  prepassResponse?: string;
  /** System prompt sent to the pruning LLM. */
  prepassSystemPrompt?: string;
  /** Latency of the prepass LLM call in milliseconds. */
  prepassLatencyMs?: number;
  /** Token usage reported by the prepass LLM call, when available. */
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  /** Error message if pruning prepass failed. */
  prepassError?: string;
  /** Reason surfaced when a keep-all safeguard retained every item (prepass pruned 100% of a category, or a non-JSON parse failure). */
  prepassSafeguardReason?: string;
}

export type PruningMode = 'auto' | 'shadow' | 'off' | 'custom';

/** Subset of pruning config exposed in the settings UI. */
export interface PruningSettings {
  mode: PruningMode;
  skillCeiling: number;
  toolCeiling: number;
  /** Skills that should never be pruned. */
  skillAlwaysKeep: string[];
  /** Tools that should never be pruned. */
  toolAlwaysKeep: string[];
  /** Model used for the pruning prepass LLM call. */
  model: string;
  /** Provider for the pruning prepass model. */
  provider: string;
  /** Thinking level for the pruning prepass. */
  thinkingLevel: ThinkingLevel;
  /** Optional timeout override for the pruning prepass, in seconds. */
  prepassTimeoutSec?: number | null;
  /** Optional auto-skip threshold (estimated input tokens) below which the
   *  skill-pruner prepass is skipped for small/trivial turns (Brief F #4).
   *  `null`/absent = disabled (always run the prepass). Persisted to
   *  settings.json so the SDK skill-pruner can consume it; the actual skip
   *  behavior is a cross-repo follow-up in @earendil-works/pi-coding-agent
   *  (see TODO.md). */
  autoSkipBelowTokens?: number | null;
}

export interface PruningCatalog {
  skills: string[];
  tools: string[];
}

export type UiDensity = 'compact' | 'comfortable' | 'spacious';

/**
 * User-configured model buckets for subagent model selection. Each bucket is a
 * list of model ids; `selectModel` picks uniformly at random from the requested
 * bucket. Empty buckets fall back to the parent's active model. Mirrored to the
 * in-process subagent extension via {@link SUBAGENT_BUCKETS_ENV}.
 */
export interface SubagentBuckets {
  small: string[];
  medium: string[];
  frontier: string[];
}

/** Empty buckets — the default before the user configures any models. */
export const EMPTY_SUBAGENT_BUCKETS: SubagentBuckets = { small: [], medium: [], frontier: [] };

/**
 * Per-tier allowlist restricting which buckets *nested* subagents (depth ≥ 1)
 * may use. When a nested subagent requests a disallowed tier, the in-process
 * subagent extension downgrades to the highest allowed tier at or below the
 * request. All-true (the default) leaves behaviour unchanged. Mirrored to the
 * in-process subagent extension via {@link NESTED_ALLOWED_BUCKETS_ENV}.
 */
export interface NestedAllowedBuckets {
  small: boolean;
  medium: boolean;
  frontier: boolean;
}

/** All buckets allowed for nested subagents — the default before the user restricts any tier. */
export const ALL_NESTED_BUCKETS_ALLOWED: NestedAllowedBuckets = { small: true, medium: true, frontier: true };

export interface ChatPrefs {
  autoExpandReasoning: boolean;
  autoExpandToolCalls: boolean;
  autoExpandSubagentCalls: boolean;
  suppressCompletionNotifications: boolean;
  showPruningMessages: boolean;
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  /** When true, host-side `auditLog` events are emitted to the extension host
   *  console (exthost.log) even in production/installed mode. Off by default;
   *  dev mode (`extensionMode === 1`) always emits regardless of this flag.
   *  Audit events are always written to the unified `pie` OutputChannel and the
   *  persistent pie log file; this flag only gates console emission.
   *  Useful for debugging pie behaviour without running the extension from source. */
  runtimeAuditLog: boolean;
  /** Max nesting depth for subagents (main → L1 → L2 → ...). 0 disables
   *  subagents entirely; higher values allow deeper nesting. Default 3.
   *  Mirrored to the in-process subagent extension via PIE_SUBAGENT_MAX_DEPTH. */
  subagentMaxDepth: number;
  /** Max total subagent sessions permitted across an entire nested tree
   *  (independent of the per-reply cap). Default 10. Mirrored to the in-process
   *  subagent extension via PIE_SUBAGENT_MAX_TREE_SESSIONS. */
  subagentMaxTreeSessions: number;
  /** Max concurrent in-flight subagent sessions across the whole process.
   *  Default 2. Mirrored via PIE_SUBAGENT_MAX_INFLIGHT. */
  subagentMaxInflight: number;
  /** Max concurrency within one parallel `tasks[]` array. Default 2.
   *  Mirrored via PIE_SUBAGENT_MAX_CONCURRENCY. */
  subagentMaxConcurrency: number;
  /** Max parallel tasks allowed in a single `subagent` call. Default 4.
   *  Mirrored via PIE_SUBAGENT_MAX_PARALLEL_TASKS. */
  subagentMaxParallelTasks: number;
  /** User-configured model ids per bucket for subagent model selection. The
   *  subagent tool picks uniformly at random from the requested bucket; an empty
   *  bucket falls back to the parent's active model. Mirrored to the in-process
   *  subagent extension via PIE_SUBAGENT_BUCKETS_JSON. Default: all empty. */
  subagentBuckets: SubagentBuckets;
  /** Per-tier allowlist restricting which buckets nested subagents (depth ≥ 1)
   *  may use. A nested subagent requesting a disallowed tier is downgraded to the
   *  highest allowed tier at or below it. Mirrored to the in-process subagent
   *  extension via PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON. Default: all true. */
  subagentNestedAllowedBuckets: NestedAllowedBuckets;
  completionSoundVolume: number;
  /** Base font size (px) for body text and message prose — the primary
   *  readable content (assistant/user messages and the inline editor). Drives
   *  --panel-font-size. Default 13 reproduces the bundled size. */
  uiBaseFontSize: number;
  /** Font size (px) for the composer input textarea (where you type). Drives
   *  --panel-composer-font-size, independent of the base size so the input can
   *  be sized for comfort without rescaling the transcript. Default 13. */
  uiComposerFontSize: number;
  /** Font size (px) for expanded collapsible sections — tool-call bodies,
   *  reasoning, system prompts, pruning raw output, and code blocks. Smaller
   *  than the 13px raw agent output since expanded text is lower priority. */
  expandedSectionFontSize: number;
  /** Max height (px) for expanded collapsible sections — reasoning, shell
   *  terminal output, tool-result pres, and the subagent message thread. Caps
   *  how tall any one expanded pane can grow so a single block can't dominate
   *  the transcript; per-pane drag overrides remain ephemeral. Default 240. */
  expandedSectionMaxHeight: number;
  /** Override for the sans-serif UI font stack (sets --panel-font-sans).
   *  Empty string falls back to the bundled default (Inter / Segoe UI / system). */
  uiFontSans: string;
  /** Override for the monospace font stack (sets --panel-font-mono), used for
   *  code blocks and tool output. Empty string falls back to the bundled default. */
  uiFontMono: string;
  /** Override for the accent color (sets --panel-accent) as a CSS color string
   *  (e.g. '#d7a942'). Empty string falls back to the bundled default. */
  uiAccentColor: string;
  /** Override for the muted text color (sets --panel-muted) used for secondary
   *  labels, hints, and metadata. Empty string falls back to the shade derived
   *  from --panel-foreground (or the bundled default when foreground is also
   *  empty). */
  uiMutedColor: string;
  /** Override for the link color (sets --panel-link) used for hyperlinks in
   *  message bodies and prompts. Empty string falls back to --panel-accent
   *  (the bundled default link appearance). */
  uiLinkColor: string;
  /** Max width (%) of chat bubbles (sets --message-assistant-width). Also
   *  scales the narrow variant up by 4 points (clamped to 100). The bundled
   *  default is 88. */
  uiMessageWidth: number;
  /** Base background color. Drives the whole --panel-ink ramp that every
   *  surface token (cards, inputs, hover, overlays) derives from. Empty string
   *  falls back to the bundled night palette. */
  uiBackground: string;
  /** Foreground text color (sets --panel-foreground; --panel-foreground-soft
   *  and --panel-muted are derived toward the background). Empty = default. */
  uiForeground: string;
  /** Border color (sets --panel-border; --panel-border-subtle is derived).
   *  Empty = bundled default. */
  uiBorder: string;
  /** Base corner radius in px. Drives the --panel-radius-* scale as r-2 / r /
   *  r+2 / r+4. Default 8 reproduces the bundled 6/8/10/12 ramp. */
  uiCornerRadius: number;
  /** Spacing density. Drives the --panel-gap-* scale. 'comfortable' reproduces
   *  the bundled defaults. */
  uiDensity: UiDensity;
  /** Per-extension enabled/disabled toggles. Keys are extension IDs. */
  extensionToggles: Record<string, boolean>;
  /** Per-provider enabled/disabled toggles. Keys are provider names. */
  providerToggles: Record<string, boolean>;
  /** Content rows reserved in the live activity-tail preview (the streaming
   *  reasoning/reply text or a running tool/subagent's output shown at the
   *  bottom of a turn). Tools/subagents add one header row on top. Default 2
   *  reproduces the bundled 2-row (reasoning) / 3-row (tool) preview. */
  activityTailLines: number;
}

/** Environment key used to expose pie provider toggles to in-process pi extensions. */
export const PROVIDER_TOGGLES_ENV = 'PIE_PROVIDER_TOGGLES_JSON';

/** Environment key used to expose pie extension toggles to in-process pi extensions. */
export const EXTENSION_TOGGLES_ENV = 'PIE_EXTENSION_TOGGLES_JSON';

/** Environment key used to mirror the user-configured subagent model buckets to
 *  the in-process subagent extension. Value is JSON `SubagentBuckets`. */
export const SUBAGENT_BUCKETS_ENV = 'PIE_SUBAGENT_BUCKETS_JSON';

/** Environment key used to mirror the nested-bucket allowlist (which tiers
 *  nested subagents may use) to the in-process subagent extension. Value is JSON
 *  `NestedAllowedBuckets`. */
export const NESTED_ALLOWED_BUCKETS_ENV = 'PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON';

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';

export interface ActiveRunSummary {
  runId: string;
  status: ActiveRunStatus;
  scored: boolean;
  /** True when the next send is queued to start a new task group. */
  nextSendStartsNewTask?: boolean;
}

export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  /** Intended to be a user-facing ordinal score (e.g. 1–5). */
  satisfaction: number;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: false,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  subagentAlwaysParentModel: false,
  runtimeAuditLog: false,
  subagentMaxDepth: 3,
  subagentMaxTreeSessions: 10,
  subagentMaxInflight: 2,
  subagentMaxConcurrency: 2,
  subagentMaxParallelTasks: 4,
  subagentBuckets: { ...EMPTY_SUBAGENT_BUCKETS },
  subagentNestedAllowedBuckets: { ...ALL_NESTED_BUCKETS_ALLOWED },
  completionSoundVolume: 50,
  uiBaseFontSize: 13,
  uiComposerFontSize: 13,
  expandedSectionFontSize: 12,
  expandedSectionMaxHeight: 240,
  uiFontSans: '',
  uiFontMono: '',
  uiAccentColor: '',
  uiMutedColor: '',
  uiLinkColor: '',
  uiMessageWidth: 88,
  uiBackground: '',
  uiForeground: '',
  uiBorder: '',
  uiCornerRadius: 8,
  uiDensity: 'comfortable',
  extensionToggles: {},
  providerToggles: {},
  activityTailLines: 2,
};

export const DEFAULT_PRUNING_SETTINGS: PruningSettings = {
  mode: 'auto',
  skillCeiling: 5,
  toolCeiling: 5,
  skillAlwaysKeep: [],
  toolAlwaysKeep: [],
  model: 'gpt-5.4-mini',
  provider: 'github-copilot',
  thinkingLevel: 'minimal',
  prepassTimeoutSec: null,
  autoSkipBelowTokens: null,
};

/**
 * Pure merge of a partial pruning-settings update into the current settings.
 *
 * Top-level scalars are replaced when present in `updates`; the
 * `skillAlwaysKeep`/`toolAlwaysKeep` arrays are replaced (and copied, so the
 * reducer never aliases the caller's array). `prepassTimeoutSec` uses an
 * explicit `undefined` check so a caller can set it to `null` (clearing the
 * override) rather than omitting it. This must produce the same shape as the
 * disk-write merge in `writePruningSettings` so the reducer's optimistic state
 * matches the persisted state.
 */
export function mergePruningSettings(
  current: PruningSettings,
  updates: Partial<PruningSettings>,
): PruningSettings {
  return {
    mode: updates.mode !== undefined ? updates.mode : current.mode,
    skillCeiling: updates.skillCeiling !== undefined ? updates.skillCeiling : current.skillCeiling,
    toolCeiling: updates.toolCeiling !== undefined ? updates.toolCeiling : current.toolCeiling,
    skillAlwaysKeep:
      updates.skillAlwaysKeep !== undefined ? [...updates.skillAlwaysKeep] : current.skillAlwaysKeep,
    toolAlwaysKeep:
      updates.toolAlwaysKeep !== undefined ? [...updates.toolAlwaysKeep] : current.toolAlwaysKeep,
    model: updates.model !== undefined ? updates.model : current.model,
    provider: updates.provider !== undefined ? updates.provider : current.provider,
    thinkingLevel:
      updates.thinkingLevel !== undefined ? updates.thinkingLevel : current.thinkingLevel,
    prepassTimeoutSec:
      updates.prepassTimeoutSec !== undefined ? updates.prepassTimeoutSec : current.prepassTimeoutSec,
    autoSkipBelowTokens:
      updates.autoSkipBelowTokens !== undefined ? updates.autoSkipBelowTokens : current.autoSkipBelowTokens,
  };
}

export const EMPTY_TRANSCRIPT_WINDOW: TranscriptWindow = {
  totalCount: 0,
  loadedStart: 0,
  loadedEnd: 0,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: false,
};

/**
 * Coerce an unknown stored value into a valid {@link SubagentBuckets}, dropping
 * non-array / non-string entries. Used by {@link resolveChatPrefs} so a
 * malformed or partially-stored value (e.g. from an older version) can never
 * produce an ill-typed `subagentBuckets` at runtime.
 */
export function normalizeSubagentBuckets(value: unknown): SubagentBuckets {
  const coerce = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_SUBAGENT_BUCKETS };
  }
  const v = value as Record<string, unknown>;
  return {
    small: coerce(v.small),
    medium: coerce(v.medium),
    frontier: coerce(v.frontier),
  };
}

/**
 * Coerce an unknown stored value into a valid {@link NestedAllowedBuckets},
 * defaulting missing / non-boolean keys to `true` (allowed). Used by
 * {@link resolveChatPrefs} so a malformed or partially-stored value (e.g. from
 * an older version) can never silently block every nested tier at runtime.
 */
export function normalizeNestedAllowedBuckets(value: unknown): NestedAllowedBuckets {
  const coerce = (v: unknown): boolean => (typeof v === 'boolean' ? v : true);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...ALL_NESTED_BUCKETS_ALLOWED };
  }
  const v = value as Record<string, unknown>;
  return {
    small: coerce(v.small),
    medium: coerce(v.medium),
    frontier: coerce(v.frontier),
  };
}

export function resolveChatPrefs(prefs?: Partial<ChatPrefs> | null): ChatPrefs {
  return {
    ...DEFAULT_CHAT_PREFS,
    ...prefs,
    extensionToggles: {
      ...DEFAULT_CHAT_PREFS.extensionToggles,
      ...(prefs?.extensionToggles ?? {}),
    },
    providerToggles: {
      ...DEFAULT_CHAT_PREFS.providerToggles,
      ...(prefs?.providerToggles ?? {}),
    },
    subagentBuckets: normalizeSubagentBuckets(prefs?.subagentBuckets),
    subagentNestedAllowedBuckets: normalizeNestedAllowedBuckets(prefs?.subagentNestedAllowedBuckets),
    autoExpandSubagentCalls:
      prefs?.autoExpandSubagentCalls
      ?? prefs?.autoExpandToolCalls
      ?? DEFAULT_CHAT_PREFS.autoExpandSubagentCalls,
  };
}

// ─── Extension UI types ──────────────────────────────────────────────────────

