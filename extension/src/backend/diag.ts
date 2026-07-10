/**
 * Backend diagnostic logger — a single shared `backendTrace` sink used by the
 * backend's I/O modules (session-metadata, subagent-profiles,
 * system-prompt-toggle-store) for structured stderr JSON lines.
 *
 * Consolidated from three identical per-module copies. The backend is a spawned
 * child process; it logs via `process.stderr.write` JSON lines captured by the
 * host's `BackendClient.logStderrLine` → the "pie (backend)" OutputChannel.
 * (Distinct from `session-event-handler.ts`'s `logBackendDiagnostic`, which is
 * event-scoped rather than scope-scoped and stays local to that module.)
 */

/** Write a structured diagnostic JSON line to stderr (captured by the host).
 *  `scope` is prefixed with `backend-` so host-side filtering can attribute the
 *  line to its originating module. `payload` fields are spread into the object
 *  (callers pass `level`, `error`, and module-specific context). */
export function backendTrace(scope: string, event: string, payload: Record<string, unknown>): void {
  process.stderr.write(`[pie:backend] ${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: `backend-${scope}`,
    event,
    ...payload,
  })}\n`);
}
