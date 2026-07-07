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
  /** Size of the per-session warm bash pool (pre-warmed bash processes that
   *  hide shell-spawn latency). 0 disables warm bash (today's fresh-spawn
   *  behaviour). Default 2. Mirrored via PIE_BASH_WARM_POOL. Applies on the
   *  next bash call (the pool is rebuilt live when this changes). */
  bashWarmPoolSize: number;
  /** When true, simple commands (no shell metacharacters) are exec'd directly
   *  without spawning bash at all. Default true. Mirrored via PIE_BASH_FAST_PATH. */
  bashFastPath: boolean;
  /** Explicit bash binary path for the warm pool + fallback (default: auto-detect
   *  Git Bash / bash). Mirrored via PIE_SHELL. */
  bashShellPath: string;
  /** Warmup wait (ms) for a bash process to print the ready marker. 0 = built-in
   *  default (10000). Mirrored via PIE_BASH_WARMUP_TIMEOUT_MS. Range [0, 60000].
 *  Applies on the next bash call (the pool is rebuilt live when this changes). */
  bashWarmupTimeoutMs: number;
  /** Acquire wait (ms) for a ready worker when the pool is empty. 0 = built-in
   *  default (15000). Mirrored via PIE_BASH_ACQUIRE_TIMEOUT_MS. Range [0, 60000]. */
  bashAcquireTimeoutMs: number;
  /** Default timeout (seconds) for bash commands that don't specify one.
   *  The upstream SDK default is 600s; this caps the worst-case hang for a
   *  simple command. Range [1, 600]. Mirrored via PIE_BASH_DEFAULT_TIMEOUT. */
  bashDefaultTimeout: number;
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
  /** User-configured list of tool names to always drop from subagent sessions
   *  (e.g. ["ask_user"]). Subtracted from every subagent's effective tool set,
   *  regardless of the agent's `tools:` frontmatter. Empty (default) → no tools
   *  dropped. Mirrored to the in-process subagent extension via
   *  PIE_SUBAGENT_DROP_TOOLS_JSON. */
  subagentDropTools: string[];
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
  /** Size (px) of the clickable user-message markers in the thin rail to the
   *  left of the transcript scrollbar. Each marker is a jump-to button; this
   *  controls the click-target height AND the visible dot size (the dot scales
   *  with it, clamped to the 10px rail width). Default 20 is a comfortable,
   *  clearly visible marker; smaller values are more compact, larger values are
   *  easier to click and see. Range 8–40. */
  uiMessageRailSize: number;
  /** Hide the bottom usage status strip (today/wk cost, tok/s, tab count, last
   *  run). The strip is auxiliary info, not core to chatting; this hides it
   *  entirely. Default false (visible). */
  hideStatusStrip: boolean;
  /** Hide the tokens-per-second (tok/s) indicator chip in the composer
   *  toolbar. Default false (visible). */
  hideTokenRate: boolean;
  /** Hide the per-session token-usage indicator chip in the composer toolbar.
   *  Default false (visible). */
  hideSessionTokens: boolean;
  /** Hide the per-session cost indicator chip in the composer toolbar.
   *  Default false (visible). */
  hideSessionCost: boolean;
  /** Hide the context-window usage indicator chip in the composer toolbar.
   *  Default false (visible). */
  hideContextIndicator: boolean;
  /** Hide the run-status chip (scored/open/etc.) in the composer toolbar.
   *  Default false (visible). */
  hideRunStatus: boolean;
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
  bashWarmPoolSize: 2,
  bashFastPath: true,
  bashShellPath: '',
  bashWarmupTimeoutMs: 0,
  bashAcquireTimeoutMs: 0,
  bashDefaultTimeout: 60,
  subagentBuckets: { ...EMPTY_SUBAGENT_BUCKETS },
  subagentNestedAllowedBuckets: { ...ALL_NESTED_BUCKETS_ALLOWED },
  subagentDropTools: [],
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
  uiMessageRailSize: 20,
  hideStatusStrip: false,
  hideTokenRate: false,
  hideSessionTokens: false,
  hideSessionCost: false,
  hideContextIndicator: false,
  hideRunStatus: false,
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

export interface ToolResultPruningRuleToggles {
  ansi: boolean;
  whitespace: boolean;
  blankRun: boolean;
  jsonMinify: boolean;
  /** Lossy-recoverable rules (only run under the `default` profile). */
  lsLong: boolean;
  gitLog: boolean;
}

export interface ToolResultPruningSettings {
  enabled: boolean;
  profile: 'default' | 'security';
  rules: ToolResultPruningRuleToggles;
  /** Allowlist of tool names pruning acts on. `null` (default) = all tools
   *  except `read` are eligible. A non-empty array restricts pruning to the
   *  listed tools; an empty array prunes nothing. `read` is always skipped
   *  (hard safety) even if listed. Configurable from the settings menu. */
  tools: string[] | null;
}

export const DEFAULT_TOOL_RESULT_PRUNING_SETTINGS: ToolResultPruningSettings = {
  enabled: true,
  profile: 'default',
  rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true },
  tools: null,
};

/** Partial update shape for {@link mergeToolResultPruningSettings}. The
 *  `rules` sub-object is itself partial (deep-merge: each toggle is replaced
 *  when present), so callers can flip one toggle without spreading the rest. */
export type ToolResultPruningSettingsUpdate = Partial<Omit<ToolResultPruningSettings, 'rules'>> & {
  rules?: Partial<ToolResultPruningRuleToggles>;
};

/**
 * Pure merge of a partial tool-result-pruning-settings update into the
 * current settings.
 *
 * Top-level scalars (`enabled`, `profile`) are replaced when present in
 * `updates`. The `rules` sub-object is deep-merged: each toggle is replaced
 * when present. This must produce the same shape as the disk-write merge in
 * `writeToolResultPruningSettings` so the reducer's optimistic state matches
 * the persisted state.
 */
export function mergeToolResultPruningSettings(
  current: ToolResultPruningSettings,
  updates: ToolResultPruningSettingsUpdate,
): ToolResultPruningSettings {
  // Preserve the `rules` object reference when the update omits it (avoids
  // needless re-renders downstream of the reducer's optimistic apply). A
  // partial `rules` sub-object is deep-merged toggle-by-toggle into a new object.
  const rules = updates.rules === undefined
    ? current.rules
    : {
        ansi: updates.rules.ansi !== undefined ? updates.rules.ansi : current.rules.ansi,
        whitespace: updates.rules.whitespace !== undefined ? updates.rules.whitespace : current.rules.whitespace,
        blankRun: updates.rules.blankRun !== undefined ? updates.rules.blankRun : current.rules.blankRun,
        jsonMinify: updates.rules.jsonMinify !== undefined ? updates.rules.jsonMinify : current.rules.jsonMinify,
        lsLong: updates.rules.lsLong !== undefined ? updates.rules.lsLong : current.rules.lsLong,
        gitLog: updates.rules.gitLog !== undefined ? updates.rules.gitLog : current.rules.gitLog,
      };
  // `tools`: preserve the current value/reference when omitted; copy arrays so
  // the reducer never aliases the caller's array; pass `null` through as a real
  // value (clears the allowlist).
  const tools = updates.tools === undefined
    ? current.tools
    : Array.isArray(updates.tools)
      ? [...updates.tools]
      : updates.tools;
  return {
    enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
    profile: updates.profile !== undefined ? updates.profile : current.profile,
    rules,
    tools,
  };
}

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

export interface ProxyGatewaySettings {
  routerSettings: {
    numRetries: number;
    retryAfter: boolean;
    timeout: number;
    /** Per-exception retry overrides, emitted verbatim to LiteLLM's
     *  `router_settings.retry_policy`. Keys are LiteLLM's PascalCase field
     *  names (e.g. `RateLimitErrorRetries`). `RateLimitErrorRetries: 0`
     *  stops LiteLLM from retrying upstream 429/account-suspended responses —
     *  retrying a suspended account deepens the pause (see the account-pause
     *  circuit-breaker in proxy/pie_proxy_runtime.py). */
    retryPolicy?: Record<string, number>;
  };
  litellmSettings: { dropParams: boolean };
  generalSettings: { masterKeyEnv: string };
}

export interface ProxyProviderUpstream {
  apiBase: string;
  apiKeyEnv: string;
  litellmProvider: string;
  maxConcurrentRequests: number;
  /** Per-session sticky-slot afterburn window in seconds (0 = disabled). When
   *  a session's LLM call finishes, the concurrency slot it held stays reserved
   *  for THAT session for this many seconds before being released to queued
   *  sessions — a follow-up from the same session (e.g. a sub-agent right after
   *  a short tool call) reuses its reserved slot, so a bursty session keeps its
   *  turn instead of interleaving with waiting sessions. Per-slot, so it
   *  generalises to maxConcurrentRequests > 1. Optional: absent/0 = disabled.
   *  The proxy reads this from settings.json directly (see proxy/.env.example
   *  PIE_PROXY_AFTERBURN_S for the global env default). */
  afterburnSeconds?: number;
  litellmModelInfoId: string;
  modelListOrder: string[];
  alias: Record<string, string>;
}

/** Input for the "Add Provider" form in the proxy settings UI. The host owns
 *  the deterministic wiring: it derives `apiKeyEnv` from `name` (`<NAME>_API_KEY`),
 *  stores the `apiKey` safely in `proxy/.env` (gitignored) + `process.env`,
 *  writes a `proxy.providers.<name>` entry to settings.json (with an empty
 *  `modelListOrder` and a `<name>-shared` model-info id), runs `sync-models`,
 *  and restarts the proxy. The provider's model CATALOG (`models.yaml`
 *  `providers.<name>` + `profileOrder` + populating `modelListOrder`) is added
 *  separately by the `add-provider` skill — until then the provider is
 *  "pending" (routes nothing, sync-models tolerates it).
 *
 *  `apiKey` is the actual secret (never persisted to settings.json/models.yaml);
 *  `name` is the provider key used across proxy.providers + models.yaml. */
export interface ProxyProviderAddInput {
  /** Provider key (lowercase, no spaces; e.g. `openrouter`). Used as the
   *  `proxy.providers.<name>` + `models.yaml providers.<name>` key. */
  name: string;
  /** Upstream API base URL (e.g. `https://openrouter.ai/api/v1`). */
  apiBase: string;
  /** Upstream API key (the secret). Stored to `proxy/.env` as `<NAME>_API_KEY`,
   *  never written to settings.json/models.yaml. */
  apiKey: string;
  /** LiteLLM provider type for routing (e.g. `openai` for OpenAI-compatible
   *  endpoints, `anthropic`, `azure`, ...). */
  litellmProvider: string;
  /** Per-provider concurrency cap (LiteLLM `max_parallel_requests`). Default 4. */
  maxConcurrentRequests?: number;
}

/** Default per-provider concurrency cap when none is supplied. Matches the
 *  umans upstream (4 concurrent active sessions). */
export const DEFAULT_PROXY_PROVIDER_MAX_CONCURRENT = 4;

/** Derive an `apiKeyEnv` var name from a provider name: uppercase, non-
 *  alphanumerics → `_`, suffixed with `_API_KEY` (e.g. `openrouter` →
 *  `OPENROUTER_API_KEY`, `my-provider` → `MY_PROVIDER_API_KEY`). Returns null
 *  when the name has no usable alphanumerics. Pure (no side effects) so the
 *  reducer and the host service can share it and stay in sync. */
export function deriveApiKeyEnv(providerName: string): string | null {
  const cleaned = providerName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return null;
  return `${cleaned}_API_KEY`;
}

/** Build the full `ProxyProviderUpstream` entry for a newly-added provider.
 *  Used by BOTH the reducer (optimistic apply) and the host service (persist),
 *  so optimistic state always matches persisted state — mirroring the
 *  `mergeProxySettings` contract for `SetProxySettings`. The entry starts
 *  "pending": `modelListOrder` is empty and `litellmModelInfoId` is
 *  `<name>-shared` (account-wide semaphore, like umans). The add-provider skill
 *  populates `modelListOrder` + the models.yaml catalog separately. */
export function buildProxyProviderEntry(input: ProxyProviderAddInput): ProxyProviderUpstream | null {
  const name = input.name.trim().toLowerCase();
  if (!name) return null;
  const apiKeyEnv = deriveApiKeyEnv(name);
  if (!apiKeyEnv) return null;
  return {
    apiBase: input.apiBase.trim(),
    apiKeyEnv,
    litellmProvider: input.litellmProvider.trim(),
    maxConcurrentRequests: input.maxConcurrentRequests && input.maxConcurrentRequests >= 1
      ? Math.floor(input.maxConcurrentRequests)
      : DEFAULT_PROXY_PROVIDER_MAX_CONCURRENT,
    litellmModelInfoId: `${name}-shared`,
    modelListOrder: [],
    alias: {},
  };
}

export interface ProxySettings {
  gateway: ProxyGatewaySettings;
  providers: Record<string, ProxyProviderUpstream>;
}

/** Partial-update shape for proxy settings. Gateway sub-objects are replaced
 *  wholesale when present (each is a small flat object); provider entries are
 *  merged per-provider, so a single provider field can be patched without
 *  resending the whole entry. Used by {@link mergeProxySettings}, the
 *  SetProxySettings command/effect, the webview message, and the host service. */
export type ProxySettingsUpdate = {
  gateway?: {
    routerSettings?: ProxyGatewaySettings['routerSettings'];
    litellmSettings?: ProxyGatewaySettings['litellmSettings'];
    generalSettings?: ProxyGatewaySettings['generalSettings'];
  };
  providers?: Record<string, Partial<ProxyProviderUpstream>>;
};

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  gateway: {
    routerSettings: {
      numRetries: 2,
      retryAfter: true,
      timeout: 600,
      // Stop LiteLLM retrying upstream 429 / account-suspended responses.
      // Retrying a paused account deepens the pause; the proxy-level
      // circuit-breaker short-circuits subsequent requests instead.
      retryPolicy: { RateLimitErrorRetries: 0 },
    },
    litellmSettings: { dropParams: true },
    // Pie-managed local proxy gate (auto-generated + persisted, see
    // proxy-master-key.ts). NOT a provider key — decoupled so any number of
    // proxied providers each with their own upstream key auth to the proxy.
    generalSettings: { masterKeyEnv: 'PIE_PROXY_MASTER_KEY' },
  },
  // No providers are hardcoded — providers are user-configured in settings.json
  // `proxy.providers` (one entry per proxied provider). Adding a provider is a
  // config-only operation (settings.json + models.yaml), no code change.
  providers: {},
};

/** Deep-merge a partial proxy-settings update into the current settings.
 *
 *  Gateway sub-fields (`routerSettings` / `litellmSettings` /
 *  `generalSettings`) are replaced wholesale when present in `updates` (each
 *  is a small flat object edited field-by-field from the UI, so a partial
 *  gateway update is itself a complete sub-object). Per-provider entries are
 *  merged individually: a partial provider update deep-merges into the
 *  existing provider entry; `modelListOrder` (replaced + copied) and `alias`
 *  (replaced + shallow-copied) are replaced when present. This must produce
 *  the same shape as the disk-write merge in `writeProxySettings` so the
 *  reducer's optimistic state matches the persisted state. */
export function mergeProxySettings(
  current: ProxySettings,
  updates: ProxySettingsUpdate,
): ProxySettings {
  const gateway: ProxyGatewaySettings = updates.gateway
    ? {
        routerSettings: updates.gateway.routerSettings ?? current.gateway.routerSettings,
        litellmSettings: updates.gateway.litellmSettings ?? current.gateway.litellmSettings,
        generalSettings: updates.gateway.generalSettings ?? current.gateway.generalSettings,
      }
    : current.gateway;

  const providers: Record<string, ProxyProviderUpstream> = { ...current.providers };
  if (updates.providers) {
    for (const [name, partial] of Object.entries(updates.providers)) {
      if (!partial) continue;
      const base = providers[name];
      if (!base) {
        // New provider entry: keep only valid fields, fall back to defaults
        // for any missing required field so ArchState stays well-typed.
        const entry: ProxyProviderUpstream = {
          apiBase: partial.apiBase ?? '',
          apiKeyEnv: partial.apiKeyEnv ?? '',
          litellmProvider: partial.litellmProvider ?? '',
          maxConcurrentRequests: partial.maxConcurrentRequests ?? 1,
          litellmModelInfoId: partial.litellmModelInfoId ?? '',
          modelListOrder: partial.modelListOrder ? [...partial.modelListOrder] : [],
          alias: partial.alias ? { ...partial.alias } : {},
        };
        // afterburnSeconds is optional — only surface the key when the update
        // actually carries it, so a present-undefined key never diverges from
        // an absent one under deepStrictEqual (matches coerceProvider).
        if (partial.afterburnSeconds !== undefined) {
          entry.afterburnSeconds = partial.afterburnSeconds;
        }
        providers[name] = entry;
        continue;
      }
      const merged: ProxyProviderUpstream = {
        apiBase: partial.apiBase !== undefined ? partial.apiBase : base.apiBase,
        apiKeyEnv: partial.apiKeyEnv !== undefined ? partial.apiKeyEnv : base.apiKeyEnv,
        litellmProvider: partial.litellmProvider !== undefined ? partial.litellmProvider : base.litellmProvider,
        maxConcurrentRequests: partial.maxConcurrentRequests !== undefined ? partial.maxConcurrentRequests : base.maxConcurrentRequests,
        litellmModelInfoId: partial.litellmModelInfoId !== undefined ? partial.litellmModelInfoId : base.litellmModelInfoId,
        modelListOrder: partial.modelListOrder !== undefined ? [...partial.modelListOrder] : base.modelListOrder,
        alias: partial.alias !== undefined ? { ...partial.alias } : base.alias,
      };
      const afterburn = partial.afterburnSeconds !== undefined ? partial.afterburnSeconds : base.afterburnSeconds;
      if (afterburn !== undefined) merged.afterburnSeconds = afterburn;
      providers[name] = merged;
    }
  }

  return { gateway, providers };
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
    subagentDropTools: normalizeStringArray(prefs?.subagentDropTools),
    autoExpandSubagentCalls:
      prefs?.autoExpandSubagentCalls
      ?? prefs?.autoExpandToolCalls
      ?? DEFAULT_CHAT_PREFS.autoExpandSubagentCalls,
  };
}

/** Normalize a user-configured string-array pref: accept undefined/arrays of
 *  strings, drop non-string entries, return a fresh array. Used for
 *  subagentDropTools. */
export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

// ─── Extension UI types ──────────────────────────────────────────────────────

