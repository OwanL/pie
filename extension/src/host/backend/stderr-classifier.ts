/**
 * Pure backend stderr line classifier — implements the structured stderr
 * contract used by `BackendClient.logStderrLine`.
 *
 * A backend stderr line is `[pie:backend] {json}` carrying an explicit `level`
 * field (`debug`/`info`/`warn`/`error`). Severity is read from that structured
 * field. Non-JSON / legacy lines (no parseable JSON, or JSON without a valid
 * `level`) fall back to the legacy substring classifier so no line is ever
 * dropped — this is the fail-safe for lines emitted before the migration and
 * for third-party / SDK stderr that bypasses the structured logger.
 *
 * Extracted as a pure module (no `vscode` import) so it is unit-testable in a
 * plain node test runner without the extension-host vscode mock.
 */
import { parseJsonOrThrow } from '../../shared/error-message';
import type { PieLogLevel } from '../util/pie-logger';

const BACKEND_PREFIX = '[pie:backend] ';

/** Classify a (non-empty) backend stderr line into a severity level via the
 *  structured stderr contract, falling back to legacy substring heuristics
 *  for non-JSON / level-less lines. Returns `'info'` for an empty input so the
 *  caller can pass untrimmed lines safely; callers normally short-circuit
 *  empty lines themselves. */
export function classifyBackendStderrLine(line: string): PieLogLevel {
  const trimmed = line.trim();
  if (!trimmed) {
    return 'info';
  }

  // Structured contract: parse the JSON payload (after stripping the
  // `[pie:backend] ` prefix) and read `level` directly.
  const jsonText = trimmed.startsWith(BACKEND_PREFIX) ? trimmed.slice(BACKEND_PREFIX.length) : trimmed;
  try {
    const record = parseJsonOrThrow<Record<string, unknown>>(jsonText, 'backend stderr');
    const raw = record?.level;
    if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
      return raw;
    }
  } catch {
    // Not JSON — fall through to the legacy classifier.
  }

  return legacyClassifyStderrLine(trimmed);
}

/** Legacy substring classifier preserved as the fail-safe for non-JSON /
 *  pre-migration stderr lines. Mirrors the original `logStderrLine` heuristic
 *  so behavior for un-structured lines is unchanged. */
function legacyClassifyStderrLine(trimmed: string): PieLogLevel {
  // `error`/`failed`/`exception`/`unexpectedly` surface at `warn` so genuine
  // errors are visible at the default Info level.
  if (/\b(error|failed|exception|unexpectedly)\b/i.test(trimmed)) {
    return 'warn';
  }
  // The poll / RPC / tool-execution chatter that floods the stream
  // (warm_bash.stats polls every ~2s, backend-request received/handled,
  // backend-timing, tool execution start/end) is demoted to `debug` so it's
  // hidden at the default Info level but visible when the channel is widened.
  if (
    trimmed.includes('warm_bash.stats')
    || trimmed.includes('provider_gate.metrics')
    || trimmed.includes('backend-request')
    || trimmed.includes('backend-timing')
    || trimmed.includes('tool_execution_start')
    || trimmed.includes('tool_execution_end')
  ) {
    return 'debug';
  }
  return 'info';
}