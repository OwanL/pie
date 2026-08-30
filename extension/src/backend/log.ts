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

/** Classify a worker stderr chunk into a backend log level by reading the
 *  structured `level` field from the `[pie:backend] {json}` line when present.
 *  Falls back to `'error'` for non-JSON / level-less chunks so genuine worker
 *  crashes (e.g. `[pie-worker] <stack>`) stay visible, while structured
 *  `debug`/`info`/`warn` chatter is no longer mis-reported as `error`.
 *
 *  A single chunk may contain multiple newline-delimited lines; the most
 *  severe level among them wins so a mixed batch is never under-reported. */
export function classifyWorkerStderrChunk(chunk: string): BackendLogLevel {
  let worst: BackendLogLevel | undefined;
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const jsonText = line.startsWith(BACKEND_LINE_PREFIX)
      ? line.slice(BACKEND_LINE_PREFIX.length)
      : line;
    let level: BackendLogLevel | undefined;
    let record: { level?: unknown; source?: unknown; event?: unknown } | undefined;
    try {
      record = JSON.parse(jsonText) as { level?: unknown; source?: unknown; event?: unknown };
      if (record.level === 'debug' || record.level === 'info' || record.level === 'warn' || record.level === 'error') {
        level = record.level;
      }
    } catch {
      // Not structured JSON — treat as a raw diagnostic line.
    }
    if (!level && record?.source === 'pie:warm-bash:auto-prune' && record.event === 'rewrite') {
      // Compatibility with warm-bash versions that emitted structured,
      // expected rewrite telemetry before they added an explicit debug level.
      level = 'debug';
    }
    if (!level) {
      // Non-JSON / level-less line (e.g. a worker crash stack). Surface at
      // error so it is never hidden.
      level = 'error';
    }
    if (worst === undefined || LEVEL_RANK[level] > LEVEL_RANK[worst]) {
      worst = level;
    }
  }
  // No non-empty lines → neutral `info` (matches the single-line classifier).
  return worst ?? 'info';
}

const LEVEL_RANK: Record<BackendLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
