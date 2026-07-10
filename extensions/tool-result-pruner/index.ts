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
 * Two tiers (§7.2):
 *   - LOSSLESS (always on, per-rule-toggled): ANSI strip, trailing-whitespace
 *     trim, blank-run collapse, JSON minify. Semantically identical ⇒ no
 *     recall stash needed.
 *   - LOSSY-recoverable (only under the `default` profile; per-rule-toggled):
 *     `ls -l` → names + dir marker, `git log` → oneline, grep/rg → path-grouped
 *     (drops repeated path prefixes by printing each path once and indenting
 *     its matches). Lossy ⇒ a recall
 *     stash is REQUIRED before the rewrite may enter history (§7.3): the
 *     post-truncation, pre-pruning text is written to a temp file, a fidelity
 *     marker `[pruned: <rules> — raw: <path>]` is prepended so the agent sees
 *     what was removed, and `details.pruning = { id, rawPath, rules }` records
 *     the recall contract. The agent recovers the raw by pointing the existing
 *     `read` tool at `rawPath` (the whole pipeline skips `read`, so recall is
 *     faithful). If the stash write fails, the lossy rewrite is abandoned and
 *     the lossless-only result is used instead — never silently drop (§7.3).
 *
 * Config (settings.json, sibling to `pruning` which is owned by skill-pruner):
 *   "toolResultPruning": { "enabled": true, "profile": "default",
 *                           "rules": { "ansi": true, "whitespace": true,
 *                                      "blankRun": true, "jsonMinify": true,
 *                                      "lsLong": true, "gitLog": true,
 *                                      "grepGroup": true } }
 *
 *   - enabled: master switch (default true)
 *   - profile: "default" | "security" — security keeps columns/permissions
 *     (lossy rules off; lossless rules run under every profile)
 *   - rules: per-rule toggles (default all on). A disabled rule is skipped
 *     entirely — it never fires.
 *
 * Visibility: when pruning meaningfully changes the BPE count (tokensSaved > 0),
 * the patch merges a `pruningBadge` into the result's existing `details`
 * (spread, never replace) so built-in tool details (bash `truncated`/
 * `fullOutputPath`, etc.) are preserved. The badge carries the fired rule names
 * + tokens saved so the transcript can show an inline ✂ marker. It is an
 * intentional human-visibility exception to the "telemetry stays out of
 * history" rule (rules + tokens only; no raw path). A 0-token rewrite (e.g.
 * normalizing a whitespace-only line) still applies its content patch but gets
 * no chip — ~45% of rewrites saved 0 tokens in production, all visual noise.
 * The lossy `details.pruning` recall contract (§7.3) is separate: it carries
 * the raw path and is always set when a lossy rule fires.
 *
 * The extension can also be turned off via PIE_EXTENSION_TOGGLES_JSON
 * { "tool-result-pruner": false }, the same global toggle skill-pruner honors.
 */

import type { ExtensionAPI, SessionShutdownEvent, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isExtensionDisabledByToggle, loadConfig } from "./config.js";
import { recordPruning } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { reapPrunedRawStashes, reapSessionStashes } from "./reaper.js";
import { countTokens } from "./tokenize.js";

function getSessionId(ctx: unknown): string {
  const ctxObj = ctx as Record<string, unknown> | undefined;
  const sessionManager = ctxObj?.sessionManager as { getSessionId?: () => string } | undefined;
  const id = sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

// --- Recall stash (§7.3) --------------------------------------------------
// Mirrors pi's OutputAccumulator temp-file convention (output-accumulator.js):
// `join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`)`. We use a
// `.txt` extension + `pruned-raw-` prefix so the stash is self-describing. The
// agent reads it back with the existing `read` tool (the pipeline skips `read`,
// so recall returns the pre-pruning text verbatim).
//
// Session-scoped cleanup (P1-7 follow-up): the session id is embedded in the
// filename at write time (`pruned-raw-<sessionId>-<hex>.txt`) so that on
// `session_shutdown` we can delete exactly this session's stashes via
// reapSessionStashes() (matched by prefix) without ever touching another live
// session's recall raw. The `session_shutdown` event carries no session id, but
// ctx.sessionManager is bound to the shutting-down session's own runtime, so
// getSessionId(ctx) returns that session's id. When the id is "unknown"/
// unsafe, reapSessionStashes is a no-op and the load-time age/size reaper
// remains the safety net — never an early eviction of an unresolved session's
// raw. The load-time reaper (reapPrunedRawStashes, run on extension load) also
// mops up pre-namespace stashes from older builds and crashed sessions.
let stashDirOverride: string | null = null;

/** Test seam: redirect the recall stash to a specific dir (null = os.tmpdir()). */
export function setStashDirForTesting(dir: string | null): void {
  stashDirOverride = dir;
}

function stashDir(): string {
  return stashDirOverride ?? tmpdir();
}

function stashPath(sessionId: string): { id: string; rawPath: string } {
  const id = `pruned-raw-${sessionId}-${randomBytes(8).toString("hex")}`;
  return { id, rawPath: join(stashDir(), `${id}.txt`) };
}

/** Write the pre-pruning text to a temp file for recall. Best-effort: the
 *  caller (the tool_result handler) treats a throw as "stash failed → fall
 *  back to lossless" (§7.3 hard gate). */
async function writeStash(rawPath: string, text: string): Promise<void> {
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, text, "utf-8");
}

/** Build the fidelity marker the agent sees: `[pruned: <rule> (<desc>); ... — raw: <path>]`. */
function buildFidelityMarker(recallRules: string[], markers: string[], rawPath: string): string {
  const parts = recallRules.map((r, i) => {
    const m = markers[i];
    return m ? `${r} (${m})` : r;
  });
  return `[pruned: ${parts.join("; ")} — raw: ${rawPath}]`;
}

/** Minimum net tokens a lossy rewrite must save (after the fidelity-marker
 *  overhead) to be worth applying. The marker carries the recall path — on
 *  long-temp-path platforms (Windows) it can cost ~30 tokens, so pruning a
 *  tiny `ls -l` (2 entries) would *increase* context. This gate ensures lossy
 *  only applies when it clearly helps; otherwise the lossless-only result is
 *  used (no marker, no stash, no recall contract). */
const LOSSY_MIN_NET_SAVED = 8;

export default function (pi: ExtensionAPI) {
  // Reap orphaned recall stashes (pruned-raw-*.txt) from past sessions on
  // load. Best-effort, fire-and-forget — never blocks handler registration.
  // Mirrors the temp-log-reaper run on VS Code extension activation.
  void reapPrunedRawStashes().catch(() => {
    // Best-effort cleanup — never surface a reaper failure.
  });

  // Session-scoped recall-stash cleanup (P1-7 follow-up): on `session_shutdown`
  // delete the stashes this session wrote. Stashes are namespaced by session id
  // at write time (pruned-raw-<sessionId>-<hex>.txt), so reapSessionStashes
  // only ever touches this session's files — a live session with a different
  // id is never affected. The `session_shutdown` event carries no id, but
  // ctx.sessionManager is bound to the shutting-down session's own runtime, so
  // getSessionId(ctx) returns that session's id. When the id is "unknown"/
  // unsafe, reapSessionStashes is a no-op (load-time reaper remains the safety
  // net). Best-effort, never-throwing — the .catch keeps a reap failure from breaking teardown.
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: unknown): Promise<void> => {
    await reapSessionStashes(getSessionId(ctx), { tmpDir: stashDir() }).catch(() => {
      // Best-effort cleanup — never surface a failure during teardown.
    });
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx: unknown): Promise<ToolResultEventResult | undefined> => {
    if (isExtensionDisabledByToggle()) return undefined;
    const config = loadConfig();
    const result = runPipeline(event, config);
    if (!result) return undefined;

    // Assemble the final text the model sees. Lossy rewrites require a recall
    // stash before they may enter history (§7.3). The fidelity marker carries
    // the recall path, so it has a real token cost — we only apply the lossy
    // rewrite when it saves meaningfully MORE than the marker overhead
    // (LOSSY_MIN_NET_SAVED); otherwise the lossless-only result is used (no
    // marker, no stash). If the stash write itself fails, fall back to
    // lossless — never silently drop (§7.3 hard gate).
    let finalText = result.meta.afterText;
    let effectiveRules = result.meta.rules;
    const details: Record<string, unknown> = { ...(event.details as object | null | undefined) };

    if (result.meta.recallRules.length > 0) {
      // Build the candidate (marker + lossy text) and measure net savings
      // vs the LOSSLESS fallback — the real alternative the agent gets when
      // lossy is skipped. Comparing against `beforeText` (the original) would
      // fold lossless savings (e.g. ANSI strip) into the gate and let lossy
      // apply when it *increases* context vs the lossless-only result. Measured
      // BEFORE touching disk — avoids orphan stash files for tiny outputs.
      const sessionId = getSessionId(ctx);
      const { id, rawPath } = stashPath(sessionId);
      const marker = buildFidelityMarker(result.meta.recallRules, result.meta.markers, rawPath);
      const candidate = `${marker}\n${result.meta.afterText}`;
      const netSaved = countTokens(result.meta.losslessText) - countTokens(candidate);
      if (netSaved >= LOSSY_MIN_NET_SAVED) {
        try {
          await writeStash(rawPath, result.meta.beforeText);
          finalText = candidate;
          details.pruning = { id, rawPath, rules: result.meta.recallRules };
        } catch {
          // §7.3 hard gate: stash write failed → abandon lossy, use lossless.
          finalText = result.meta.losslessText;
          effectiveRules = result.meta.rules.filter((r) => !result.meta.recallRules.includes(r));
        }
      } else {
        // Marker overhead eats the savings (tiny output) → not worth lossy.
        finalText = result.meta.losslessText;
        effectiveRules = result.meta.rules.filter((r) => !result.meta.recallRules.includes(r));
      }
    }

    // If lossy was skipped/failed and no lossless rule fired, nothing
    // effectively changed — return undefined so history keeps the original.
    if (effectiveRules.length === 0) return undefined;

    // Token math is shared by the analytics record and the visibility badge.
    // countTokens never throws (falls back to chars/4), so this is safe.
    const beforeTokens = countTokens(result.meta.beforeText);
    const afterTokens = countTokens(finalText);
    const tokensSaved = Math.max(0, beforeTokens - afterTokens);

    // Analytics: record which rules fired + before/after token counts. Only
    // when pruning actually changed content. Best-effort — recordPruning
    // swallows write failures so telemetry never breaks the pruning path.
    try {
      recordPruning({
        event: "tool_result_pruned",
        sessionId: getSessionId(ctx),
        toolName: event.toolName,
        rules: effectiveRules,
        beforeTokens,
        afterTokens,
        tokensSaved,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Telemetry must never break the pruning path.
    }

    // Visibility badge (noise-gated on tokensSaved > 0 — see header). The
    // content patch always applies; only the chip is gated.
    if (tokensSaved > 0) {
      details.pruningBadge = { rules: effectiveRules, tokensSaved };
    }
    return { content: [{ type: "text", text: finalText }], details };
  });
}
