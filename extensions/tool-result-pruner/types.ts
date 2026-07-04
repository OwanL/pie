// Internal types for the tool-result-pruner extension.
//
// See docs/TOOL-RESULT-PRUNING.md for the design. This MVP implements only the
// LOSSLESS tier (§7.2): ANSI strip, trailing-whitespace trim, blank-run
// collapse, JSON minify. Lossy-recoverable rules (ls -l, git log, tabular,
// stack traces) + the recall stash land in a follow-up pass; the Rule /
// RuleContext / Profile types are shaped so they slot in unchanged.

/** Named profile selecting which rules are eligible. */
export type Profile = "default" | "security";

export interface ToolResultPruningConfig {
  /** Master switch. When false, no rules run at all. */
  enabled: boolean;
  /** Profile name. `default` enables every shipped rule; `security` keeps
   *  columns/permissions the agent may need (lossy column-drop rules stay off
   *  — added with the lossy tier). Lossless rules run under every profile. */
  profile: Profile;
}

export const DEFAULT_CONFIG: ToolResultPruningConfig = {
  enabled: true,
  profile: "default",
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
}

/** Metadata about a pruning pass, returned alongside the patched content when
 *  at least one rule fired. Consumed by the index.ts layer to record analytics
 *  (token counts + which rules fired) — kept out of the pipeline so the
 *  pipeline stays pure and unit-testable without a tokenizer. */
export interface PruningMeta {
  /** Ordered names of the rules that changed content (only those that fired). */
  rules: string[];
  /** Post-truncation, pre-pruning text the pipeline received. */
  beforeText: string;
  /** Final post-pruning text the model sees. */
  afterText: string;
}

/** A pipeline rule. Self-contained: must catch its own failures (the pipeline
 *  also wraps each call defensively — §6 implication 3). */
export interface Rule {
  name: string;
  tier: "lossless" | "lossy";
  run: (text: string, ctx: RuleContext) => RuleResult | null;
}