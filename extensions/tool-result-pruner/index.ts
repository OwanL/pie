/**
 * tool-result-pruner — deterministic middleware that prunes tool *output* bytes
 * before they enter the model's context. One of three context-lean layers in
 * this stack (see AGENTS.md § Context-lean layers): history compaction (pi),
 * skill pruning (skill-pruner), and tool-result pruning (this).
 *
 * Hooks the `tool_result` event and rewrites `content` in place — the rewrite
 * is durable (it replaces the stored toolResult message; see
 * docs/TOOL-RESULT-PRUNING.md §6 for the verified persistence chain) and
 * cache-safe (only new results are touched, never stored history).
 *
 * MVP scope: the LOSSLESS tier only — ANSI strip, trailing-whitespace trim,
 * blank-run collapse, JSON minify. No recall stash needed (lossless ⇒ no
 * recoverable loss). The lossy tier (ls -l, git log, tabular, stack traces) +
 * recall stash land in a follow-up pass; the Rule/pipeline seam is shaped for
 * them (RuleResult gains a `marker` field and the pipeline gains stash +
 * `details.pruning` wiring then — see README). Per-rule token measurement
 * (§9.3) is wired NOW via logger.ts → data/tool-result-pruning.jsonl, ingested
 * by the analysis pipeline.
 *
 * Config (settings.json, sibling to `pruning` which is owned by skill-pruner):
 *   "toolResultPruning": { "enabled": true, "profile": "default" }
 *
 *   - enabled: master switch (default true)
 *   - profile: "default" | "security" — security keeps columns/permissions
 *     the agent may need (matters once the lossy column-drop rules ship;
 *     lossless rules run under every profile)
 *
 * The extension can also be turned off via PIE_EXTENSION_TOGGLES_JSON
 * { "tool-result-pruner": false }, the same global toggle skill-pruner honors.
 */

import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isExtensionDisabledByToggle, loadConfig } from "./config.js";
import { recordPruning } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { countTokens } from "./tokenize.js";

function getSessionId(ctx: unknown): string {
  const ctxObj = ctx as Record<string, unknown> | undefined;
  const sessionManager = ctxObj?.sessionManager as { getSessionId?: () => string } | undefined;
  const id = sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event: ToolResultEvent, ctx: unknown): Promise<ToolResultEventResult | undefined> => {
    if (isExtensionDisabledByToggle()) return undefined;
    const config = loadConfig();
    const result = runPipeline(event, config);
    if (!result) return undefined;

    // Analytics: record which rules fired + before/after token counts. Only
    // when pruning actually changed content (no event for no-op results).
    // Best-effort — recordPruning swallows write failures.
    try {
      const beforeTokens = countTokens(result.meta.beforeText);
      const afterTokens = countTokens(result.meta.afterText);
      recordPruning({
        event: "tool_result_pruned",
        sessionId: getSessionId(ctx),
        toolName: event.toolName,
        rules: result.meta.rules,
        beforeTokens,
        afterTokens,
        tokensSaved: Math.max(0, beforeTokens - afterTokens),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Telemetry must never break the pruning path.
    }

    return result.patch;
  });
}