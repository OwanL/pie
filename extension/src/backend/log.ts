/**
 * Backend structured logger — the single sink for the backend's diagnostic
 * stderr output. Every backend stderr line is a JSON object with an explicit
 * `level` field: `{ ts, pid, level, scope, event, ...data }`. The host
 * (`BackendClient.logStderrLine` → `classifyBackendStderrLine`) parses the JSON
 * and reads severity from the `level` field (the structured stderr contract),
 * falling back to substring heuristics only for non-JSON / legacy lines.
 *
 * This replaces the old ad-hoc severity scheme where callers stuffed `level`
 * into the payload and the host guessed severity from the raw line text via a
 * brittle regex (which mis-classified lines carrying an `error` field as
 * `warn` regardless of the caller's intent).
 *
 * The backend is a spawned child process; it logs via `process.stderr.write`
 * with the `[pie:backend]` line prefix captured by the host's
 * `BackendClient.logStderrLine` → the "pie (backend)" OutputChannel + pie.log.
 * The `[pie:backend]` prefix is preserved so existing host captures keep
 * working during (and after) the migration.
 *
 * Reducer purity (docs/STATE_CONTRACT.md): the reducer does NO I/O. This logger
 * is a backend-side side effect and is never imported by the host reducer.
 */

export type BackendLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Shape of a backend stderr JSON line. Extra data fields are spread in by
 *  callers (e.g. `error`, `label`, `durationMs`). */
export interface BackendLogRecord {
  ts: string;
  pid: number;
  level: BackendLogLevel;
  scope: string;
  event: string;
  [key: string]: unknown;
}

const BACKEND_LINE_PREFIX = '[pie:backend] ';

/** Write a structured diagnostic JSON line to stderr with an explicit `level`.
 *  `scope` is the full attribution scope (e.g. `backend-timing`,
 *  `backend-session`, `backend`) — callers pass the prefixed form so host-side
 *  filtering and log readability stay stable. `data` fields are spread into the
 *  record alongside the structural fields. */
export function backendLog(
  level: BackendLogLevel,
  scope: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  const record: BackendLogRecord = {
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    scope,
    event,
    ...data,
  };
  process.stderr.write(`${BACKEND_LINE_PREFIX}${JSON.stringify(record)}\n`);
}

export function backendDebug(scope: string, event: string, data?: Record<string, unknown>): void {
  backendLog('debug', scope, event, data);
}

export function backendInfo(scope: string, event: string, data?: Record<string, unknown>): void {
  backendLog('info', scope, event, data);
}

export function backendWarn(scope: string, event: string, data?: Record<string, unknown>): void {
  backendLog('warn', scope, event, data);
}

export function backendError(scope: string, event: string, data?: Record<string, unknown>): void {
  backendLog('error', scope, event, data);
}

/** Backward-compatible trace wrapper for the pre-structured call sites that pass
 *  `scope` WITHOUT the `backend-` prefix and carry `level` inside `payload`.
 *  This normalizes them to the structured `backendLog` shape: `level` is lifted
 *  out of the payload into the structural `level` field (defaulting to `debug`)
 *  and `scope` is prefixed with `backend-`. Prefer `backendLog` / the level
 *  helpers for new call sites. */
export function backendTrace(
  scope: string,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const { level: rawLevel, ...data } = payload;
  const level: BackendLogLevel =
    rawLevel === 'warn' || rawLevel === 'error' || rawLevel === 'info' || rawLevel === 'debug'
      ? (rawLevel as BackendLogLevel)
      : 'debug';
  backendLog(level, `backend-${scope}`, event, data);
}