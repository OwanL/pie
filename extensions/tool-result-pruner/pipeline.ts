// The pruning pipeline. See docs/TOOL-RESULT-PRUNING.md §7.
//
// Guards (§7.4, all enforced here before any rule runs):
//   - errors pass unfiltered (`event.isError`)
//   - `read` results skip the whole pipeline — HARD safety guard: read is
//     agent-directed; any byte-altering transform (even lossless) would desync
//     the model's view from the file's actual bytes and break `edit`'s exact
//     `oldText` match unrecoverably. This is NOT user-overridable.
//   - tool allowlist (`config.tools`): when non-null, only listed tool names are
//     eligible. `null` (default) = all non-read tools. Configurable so the user
//     can restrict which tool results pruning acts upon.
//   - multi-part / image content is left untouched (we only rewrite a single
//     text part — the common bash/ls/grep case)
//
// Runs the LOSSLESS tier (always, per-rule-toggled) then the LOSSY tier
// (only under the `default` profile — `security` keeps permissions/columns;
// each lossy rule per-rule-toggled). The lossy rewrite is gated on a recall
// stash: `meta.recallRules` non-empty is the signal that index.ts must write
// the pre-pruning text to a temp file and prepend a fidelity marker before the
// lossy text may enter history (§7.3). The pipeline itself stays pure /
// filesystem-free so it remains unit-testable without a tokenizer or disk; the
// stash write + marker assembly live in index.ts.

import type {
  RuleContext,
  RuleResult,
  PruningMeta,
  ToolResultPruningConfig,
} from "./types.js";
import { RULE_KEY_BY_NAME } from "./types.js";
import type {
  ToolContent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { LOSSLESS_RULES } from "./rules.js";
import { LOSSY_RULES } from "./lossy-rules.js";

/** Extract the single text part to prune, or null if the shape isn't safe. */
function singleText(content: ToolContent[]): string | null {
  if (content.length !== 1) return null;
  const part = content[0];
  if (part.type !== "text") return null;
  return part.text;
}

/** Run an ordered rule list defensively. Each rule is wrapped so a throw
 *  leaves `current` unchanged (§6 implication 3: never turn a good result into
 *  an error). Returns the final text, whether anything changed, the names of
 *  the rules that fired (in order), and — for lossy rules — their marker
 *  descriptions (parallel to the fired lossy rule names). */
function runRules(
  text: string,
  rules: { name: string; run: (t: string, c: RuleContext) => RuleResult | null }[],
  ctx: RuleContext,
): { text: string; changed: boolean; firedRules: string[]; markers: string[] } {
  let current = text;
  let changed = false;
  const firedRules: string[] = [];
  const markers: string[] = [];
  for (const rule of rules) {
    try {
      const result = rule.run(current, ctx);
      if (result && result.changed) {
        current = result.text;
        changed = true;
        firedRules.push(rule.name);
        markers.push(result.marker ?? ""); // keep parallel to firedRules (§7.3 marker contract)
      }
    } catch {
      // Defensive: a buggy rule never propagates. Keep current unchanged.
    }
  }
  return { text: current, changed, firedRules, markers };
}

/** Run the pipeline against a tool_result event. Returns the patch to apply
 *  (a new `content` array) plus pruning metadata, or null when nothing changed
 *  / guards say skip. The metadata is returned OUT-of-band — it is NOT placed
 *  in the patch's `details` (which is durable history). The visibility badge
 *  (`pruningBadge`) is merged into `details` by index.ts, NOT here — that keeps
 *  the pipeline pure and unit-testable without a tokenizer, and co-locates the
 *  badge with the token-count math that already runs at the index layer.
 *  `pruningBadge` is an intentional human-visibility exception to the
 *  "telemetry stays out of history" rule (rules + tokens only; no raw path;
 *  lossless ⇒ no recall needed). `details.pruning` is reserved for the lossy
 *  tier's recall contract (§7.3) and is NOT used by this lossless tier. */
export function runPipeline(
  event: ToolResultEvent,
  config: ToolResultPruningConfig,
): { patch: ToolResultEventResult; meta: PruningMeta } | null {
  if (!config.enabled) return null;
  if (event.isError) return null; // §7.4: errors pass unfiltered
  if (event.toolName === "read") return null; // §7.4: reads are agent-directed (hard safety, non-overridable)
  if (config.tools != null && !config.tools.includes(event.toolName)) return null; // allowlist restricts which tools are pruned (absent/null = all non-read tools)
  const text = singleText(event.content);
  if (text == null) return null;

  const ctx: RuleContext = {
    toolName: event.toolName,
    input: event.input,
    profile: config.profile,
  };

  // Only run lossless rules whose toggle is enabled (§A3). A disabled rule is
  // skipped entirely — it never fires, even when its transform would apply.
  const eligibleLossless = LOSSLESS_RULES.filter((rule) => {
    const key = RULE_KEY_BY_NAME[rule.name];
    return key ? config.rules[key] : true;
  });
  const lossless = runRules(text, eligibleLossless, ctx);
  const losslessText = lossless.text;

  // Lossy tier (§7.2 tier 2): only under the `default` profile — `security`
  // keeps permissions/columns the agent may need. Lossy rules run on the
  // lossless-normalized text (so parsers see clean, ANSI-free bytes) and are
  // each gated by their toggle. The recall stash is written by index.ts (the
  // pipeline stays pure / filesystem-free); recallRules non-empty is the signal
  // that a stash is required before this rewrite may enter history (§7.3).
  let afterText = losslessText;
  const markers: string[] = [];
  const recallRules: string[] = [];
  if (config.profile === "default") {
    const eligibleLossy = LOSSY_RULES.filter((rule) => {
      const key = RULE_KEY_BY_NAME[rule.name];
      return key ? config.rules[key] : true;
    });
    const lossy = runRules(losslessText, eligibleLossy, ctx);
    if (lossy.changed) {
      afterText = lossy.text;
      recallRules.push(...lossy.firedRules);
      markers.push(...lossy.markers);
    }
  }

  const rules = [...lossless.firedRules, ...recallRules];
  if (!lossless.changed && recallRules.length === 0) return null; // nothing fired

  const patch: ToolResultEventResult = {
    content: [{ type: "text", text: afterText }],
  };
  const meta: PruningMeta = {
    rules,
    beforeText: text,
    afterText,
    losslessText,
    markers,
    recallRules,
  };
  return { patch, meta };
}