import {
  BACKEND_LINE_PREFIX,
  type BackendLogLevel,
} from '../../../../lib/structured-logging/backend-log.js';

const LEVEL_RANK: Record<BackendLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Classify a worker stderr chunk by the structured backend level when present.
 *  Non-JSON and level-less lines remain errors so genuine worker crashes stay
 *  visible. For multi-line chunks the most severe level wins. */
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
      level = 'error';
    }
    if (worst === undefined || LEVEL_RANK[level] > LEVEL_RANK[worst]) {
      worst = level;
    }
  }
  return worst ?? 'info';
}

/** Worker stdout is ordinary application output rather than a protocol channel;
 *  keep it visible at info while stderr retains fail-safe crash classification. */
export function classifyWorkerDiagnosticChunk(
  stream: 'stdout' | 'stderr',
  chunk: string,
): BackendLogLevel {
  return stream === 'stdout' ? 'info' : classifyWorkerStderrChunk(chunk);
}
