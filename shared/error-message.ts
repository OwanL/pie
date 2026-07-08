/** Canonical error-normalization helpers shared across all packages
 *  (extension host/backend, webview, analysis CLI, and pi extensions).
 *
 *  Every catch site and every user-facing failure path should funnel through
 *  `toErrorMessage` so thrown values are normalized consistently regardless
 *  of shape (Error, string, {message}, {error}, {code}, null/undefined).
 *
 *  User-facing JSON reads of config/data files should use `parseJsonOrThrow`
 *  so a malformed file produces a message that names what was being parsed
 *  (and where the parse failed) instead of a bare "Unexpected token X". */

/** Normalize any thrown value into a human-readable message string.
 *  Handles Error, string, {message}, {error}, {code}, null/undefined. */
export function toErrorMessage(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (typeof e.error === 'string' && e.error.length > 0) return e.error;
    if (typeof e.code === 'string' && e.code.length > 0) return e.code;
  }
  return String(err);
}

/** Connection-level error signature. The OpenAI SDK raises
 *  `APIConnectionError` (message "Connection error.", `status` undefined) when
 *  NO HTTP response was received — ECONNREFUSED, ECONNRESET, socket hang-up,
 *  fetch failure, or a pre-headers timeout. */
const CONNECTION_ERROR_RE =
  /connection error|connection refused|socket hang up|econnreset|econnrefused|enotfound|fetch failed|network error|etimedout/i;

/** True if `err` looks like a connection-level error (no HTTP response). */
export function isConnectionError(err: unknown): boolean {
  if (err == null) return false;
  const msg = toErrorMessage(err);
  if (CONNECTION_ERROR_RE.test(msg)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && CONNECTION_ERROR_RE.test(toErrorMessage(cause))) return true;
  // OpenAI SDK APIConnectionError: no `status` (undefined) + named class.
  if (typeof err === 'object') {
    const e = err as { status?: unknown; name?: string };
    if (e.status === undefined && typeof e.name === 'string'
      && /APIConnectionError|ConnectionError/i.test(e.name)) return true;
  }
  return false;
}

/** Normalize a thrown value into a user-facing message, ENRICHING
 *  connection-level errors with the real transport `cause` so the user sees
 *  something actionable instead of a bare "Connection error." Non-connection
 *  errors (including clean 429/5xx with a body) pass through `toErrorMessage`
 *  unchanged so the real upstream reason (e.g. "account_suspended") is
 *  preserved. */
export function enrichConnectionError(err: unknown): string {
  const base = toErrorMessage(err);
  if (!isConnectionError(err)) return base;
  const cause = (err as { cause?: unknown }).cause;
  const causeMsg = cause ? toErrorMessage(cause) : '';
  const detail = causeMsg && !/connection error/i.test(causeMsg) ? ` (${causeMsg})` : '';
  return `Connection error${detail} — the upstream provider may be unreachable or the connection was dropped. Reload the window to retry; if the provider is rate-limited, the concurrency gate will surface that as a clear 429 once it recovers.`;
}

/** Parse JSON, throwing a contextual Error that names what was being parsed
 *  (`label`) so callers see e.g. "settings.json: invalid JSON — Unexpected
 *  token } in JSON at position 42" rather than a bare SyntaxError. Use for
 *  user-facing config/data file reads where a corrupt file should surface a
 *  useful message. */
export function parseJsonOrThrow<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${label}: invalid JSON — ${err.message}`);
    }
    throw new Error(`${label}: ${toErrorMessage(err)}`);
  }
}