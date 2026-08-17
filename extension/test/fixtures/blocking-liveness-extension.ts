import fs from "node:fs";
import path from "node:path";

/**
 * Phase 0 reproducer fixture. It intentionally performs synchronous marker
 * polling so the blocked process cannot make progress by awaiting a promise.
 * The test creates the release marker in finally; the deadline is a second
 * fail-safe for a broken harness or an interrupted test.
 */
const phase = process.env.PIE_BLOCKING_LIVENESS_PHASE ?? "";
const runId = process.env.PIE_BLOCKING_LIVENESS_RUN_ID ?? "";
const enteredPath = process.env.PIE_BLOCKING_LIVENESS_ENTERED;
const releasePath = process.env.PIE_BLOCKING_LIVENESS_RELEASE;
const continuedPath = process.env.PIE_BLOCKING_LIVENESS_CONTINUED;
const targetCwd = process.env.PIE_BLOCKING_LIVENESS_TARGET_CWD;
const safetyDeadlineMs = Number(process.env.PIE_BLOCKING_LIVENESS_DEADLINE_MS ?? 60_000);

// The extension is loaded through Pi's separate jiti loader. Use the same
// process-local bridge symbol as the backend so the hook's exact span is
// recorded by the backend trace store rather than by a second store.
const RUNTIME_TRACE_SINK = Symbol.for("pie.runtime-trace-sink.v1");
type RuntimeTraceSink = (event: { phase: string; durationMs: number }) => void;
type RuntimeTraceGlobal = typeof globalThis & { [RUNTIME_TRACE_SINK]?: RuntimeTraceSink };

function recordExecutionHookSpan(startedAt: number): void {
  try {
    (globalThis as RuntimeTraceGlobal)[RUNTIME_TRACE_SINK]?.({
      phase: "extension_hook",
      durationMs: Math.max(0, performance.now() - startedAt),
    });
  } catch {
    // Test-only evidence must never change the fixture's blocking behavior.
  }
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function blockSynchronously(reason: string): void {
  if (!enteredPath || !releasePath) throw new Error("Blocking liveness fixture is missing marker paths.");
  const startedAt = performance.now();
  fs.writeFileSync(enteredPath, JSON.stringify({ phase, runId, reason, pid: process.pid, enteredAt: Date.now() }), "utf8");
  const deadline = Date.now() + (Number.isFinite(safetyDeadlineMs) && safetyDeadlineMs > 0 ? safetyDeadlineMs : 60_000);
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Blocking liveness fixture exceeded its ${safetyDeadlineMs}ms safety deadline.`);
    }
  }
  if (continuedPath) {
    fs.writeFileSync(continuedPath, JSON.stringify({ phase, runId, reason, pid: process.pid, continuedAt: Date.now() }), "utf8");
  }
  if (phase === "execution-hook") recordExecutionHookSpan(startedAt);
}

export default function blockingLivenessExtension(pi: any): void {
  if (phase === "factory") {
    // The pinned SDK passes only `ExtensionAPI` to the factory (no cwd), so
    // the block cannot be scoped by cwd here. It is scoped to A by the test
    // design: the harness promotes only session A, and the factory runs once
    // per promotion, so B's cold open never reaches this code. The execution
    // hook below additionally guards by cwd for the same reason.
    blockSynchronously("extension-factory-resource-bootstrap");
  }
  if (phase === "execution-hook") {
    pi.on("before_agent_start", (_event: unknown, ctx: { cwd?: string }) => {
      // The target check lets the same temporary agent directory serve the
      // stable B session without blocking a hypothetical B promotion.
      if (!targetCwd || samePath(ctx.cwd, targetCwd)) {
        blockSynchronously("before-agent-start");
      }
    });
  }
}
