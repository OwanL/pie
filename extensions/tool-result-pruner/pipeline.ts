// The pruning pipeline. See docs/TOOL-RESULT-PRUNING.md §7.
//
// Guards (§7.4, all enforced here before any rule runs):
//   - errors pass unfiltered (`event.isError`)
//   - `read` results skip the whole pipeline (agent-directed; would desync edits)
//   - multi-part / image content is left untouched (we only rewrite a single
//     text part — the common bash/ls/grep case)
//
// MVP runs the LOSSLESS tier only. The lossy tier + recall stash will plug into
// the same `runRules` seam: it already takes the profile and yields a marker
// list; lossy rules return markers and require a stash (gated here when added).

import type {
  RuleContext,
  RuleResult,
  PruningMeta,
  ToolResultPruningConfig,
} from "./types.js";
import type {
  ToolContent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { LOSSLESS_RULES } from "./rules.js";

/** Extract the single text part to prune, or null if the shape isn't safe. */
function singleText(content: ToolContent[]): string | null {
  if (content.length !== 1) return null;
  const part = content[0];
  if (part.type !== "text") return null;
  return part.text;
}

/** Run an ordered rule list defensively. Each rule is wrapped so a throw
 *  leaves `current` unchanged (§6 implication 3: never turn a good result into
 *  an error). Returns the final text, whether anything changed, and the names
 *  of the rules that fired (in order). */
function runRules(
  text: string,
  rules: { name: string; run: (t: string, c: RuleContext) => RuleResult | null }[],
  ctx: RuleContext,
): { text: string; changed: boolean; firedRules: string[] } {
  let current = text;
  let changed = false;
  const firedRules: string[] = [];
  for (const rule of rules) {
    try {
      const result = rule.run(current, ctx);
      if (result && result.changed) {
        current = result.text;
        changed = true;
        firedRules.push(rule.name);
      }
    } catch {
      // Defensive: a buggy rule never propagates. Keep current unchanged.
    }
  }
  return { text: current, changed, firedRules };
}

/** Run the pipeline against a tool_result event. Returns the patch to apply
 *  (a new `content` array) plus pruning metadata, or null when nothing changed
 *  / guards say skip. The metadata is returned OUT-of-band — it is NOT placed
 *  in the patch's `details` (which is durable history). `details.pruning` is
 *  reserved for the lossy tier's recall contract (§7.3); telemetry stays out
 *  of stored history. */
export function runPipeline(
  event: ToolResultEvent,
  config: ToolResultPruningConfig,
): { patch: ToolResultEventResult; meta: PruningMeta } | null {
  if (!config.enabled) return null;
  if (event.isError) return null; // §7.4: errors pass unfiltered
  if (event.toolName === "read") return null; // §7.4: reads are agent-directed
  const text = singleText(event.content);
  if (text == null) return null;

  const ctx: RuleContext = {
    toolName: event.toolName,
    input: event.input,
    profile: config.profile,
  };

  const { text: rewritten, changed, firedRules } = runRules(text, LOSSLESS_RULES, ctx);
  if (!changed) return null;

  const patch: ToolResultEventResult = {
    content: [{ type: "text", text: rewritten }],
  };
  const meta: PruningMeta = {
    rules: firedRules,
    beforeText: text,
    afterText: rewritten,
  };
  return { patch, meta };
}