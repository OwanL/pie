// Internal types for the tool-result-pruner extension.
//
// See docs/TOOL-RESULT-PRUNING.md for the design. This MVP implements only the
// LOSSLESS tier (§7.2): ANSI strip, trailing-whitespace trim, blank-run
// collapse, JSON minify. Lossy-recoverable rules (ls -l, git log, tabular,
// stack traces) + the recall stash land in a follow-up pass; the Rule /
// RuleContext / Profile types are shaped so they slot in unchanged.

/** Named profile selecting which rules are eligible. */
export type Profile = "default" | "security";

/** Per-rule enable toggles. Each maps 1:1 to a rule name via `RULE_KEY_BY_NAME`.
 *  A disabled rule is skipped entirely — it never fires, even when its transform
 *  would apply. The first 4 are lossless (§7.2, tier 1, always safe); the last 2
 *  are lossy-recoverable (§7.2 tier 2 — gated on profile + recall stash). */
export interface RuleToggles {
  ansi: boolean;
  whitespace: boolean;
  blankRun: boolean;
  jsonMinify: boolean;
  lsLong: boolean;
  gitLog: boolean;
}

/** Rule name → `RuleToggles` key. The pipeline uses this to look up a rule's
 *  toggle when filtering the eligible rule list. */
export const RULE_KEY_BY_NAME: Record<string, keyof RuleToggles> = {
  "ansi-strip": "ansi",
  "trim-trailing-whitespace": "whitespace",
  "collapse-blank-runs": "blankRun",
  "minify-json": "jsonMinify",
  "ls-long": "lsLong",
  "git-log": "gitLog",
};

export const DEFAULT_RULE_TOGGLES: RuleToggles = {
  ansi: true,
  whitespace: true,
  blankRun: true,
  jsonMinify: true,
  lsLong: true,
  gitLog: true,
};

export interface ToolResultPruningConfig {
  /** Master switch. When false, no rules run at all. */
  enabled: boolean;
  /** Profile name. `default` enables every shipped rule; `security` keeps
   *  columns/permissions the agent may need (lossy column-drop rules stay off
   *  — added with the lossy tier). Lossless rules run under every profile. */
  profile: Profile;
  /** Per-rule toggles. A rule whose toggle is false is skipped entirely. */
  rules: RuleToggles;
  /** Allowlist of tool names pruning acts on. `null` (default) means every
   *  tool except `read` is eligible (current behavior). A non-empty array
   *  restricts pruning to only the listed tools; an empty array `[]` prunes
   *  nothing. `read` is ALWAYS hard-skipped (§7.4: agent-directed, would desync
   *  edits) even if listed here — the allowlist configures the *other* tools. */
  tools: string[] | null;
}

export const DEFAULT_CONFIG: ToolResultPruningConfig = {
  enabled: true,
  profile: "default",
  rules: { ...DEFAULT_RULE_TOGGLES },
  tools: null,
};

export const VALID_PROFILES = new Set<Profile>(["default", "security"]);

/** Context handed to every rule. `input` is the tool-call arguments
 *  (args-as-signal, §5 principle 2): for bash it's `{ command }`, for ls/grep
 *  it's their typed params. */
export interface RuleContext {
  toolName: string;
  input: Record<string, unknown>;
  profile: Profile;
}

/** Outcome of a single rule. `null` from the rule means "not applicable". */
export interface RuleResult {
  /** Rewritten text (post-rule). */
  text: string;
  /** True only when the rule changed at least one byte. */
  changed: boolean;
  /** Short human description of what a *lossy* rule removed (e.g. "5 entries →
   *  names only"), surfaced in the fidelity marker so the agent knows what it
   *  is not seeing. Lossless rules leave this undefined (no marker needed). */
  marker?: string;
}

/** Metadata about a pruning pass, returned alongside the patched content when
 *  at least one rule fired. Consumed by the index.ts layer to record analytics
 *  (token counts + which rules fired), write the recall stash, and assemble the
 *  fidelity marker — kept out of the pipeline so the pipeline stays pure and
 *  unit-testable without a tokenizer or filesystem. */
export interface PruningMeta {
  /** Ordered names of ALL rules that changed content (lossless + lossy). */
  rules: string[];
  /** Post-truncation, pre-pruning text the pipeline received (the recall raw). */
  beforeText: string;
  /** Final rewritten text WITHOUT the fidelity marker (the marker is prepended
   *  by index.ts after the stash write, since it carries the raw path). For a
   *  lossless-only pass this is the lossless result; for a lossy pass it is the
   *  lossy result. */
  afterText: string;
  /** The lossless-only result (post-lossless, pre-lossy). Used as the fallback
   *  if the recall stash write fails (§7.3 hard gate: never silently drop). */
  losslessText: string;
  /** Per-rule marker descriptions for lossy rules that fired (parallel to
   *  `recallRules`). Empty for a lossless-only pass. */
  markers: string[];
  /** Names of lossy rules that fired (non-empty ⇒ a recall stash is required
   *  before the lossy rewrite may enter history). */
  recallRules: string[];
}

/** Recall contract for a lossy-pruned result (§7.3). Merged into the result's
 *  `details.pruning` by index.ts after the stash is written. The agent recovers
 *  the pre-pruning text by pointing the existing `read` tool at `rawPath` (the
 *  whole pipeline skips `read`, so recall is faithful). */
export interface PruningRecall {
  /** Stable id (the stash filename stem) for log correlation. */
  id: string;
  /** Temp file path holding the post-truncation, pre-pruning text. */
  rawPath: string;
  /** Lossy rule names that fired (what was removed). */
  rules: string[];
}

/** A pipeline rule. Self-contained: must catch its own failures (the pipeline
 *  also wraps each call defensively — §6 implication 3). */
export interface Rule {
  name: string;
  tier: "lossless" | "lossy";
  run: (text: string, ctx: RuleContext) => RuleResult | null;
}