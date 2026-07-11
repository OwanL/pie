/**
 * Provider failure classification and phase-aware replay safety.
 *
 * Classifies an error thrown on the provider/SDK path into a typed failure
 * class, decides whether that class is retryable at all, extracts a
 * `Retry-After` hint when present, and assesses whether *replaying the turn*
 * would be semantically safe given how far the run has progressed:
 *
 *   - before any assistant output  → replay is side-effect-free ("safe")
 *   - after partial output, no tool → replay duplicates prose ("partial_output")
 *   - after a tool / side effect    → never silently replay ("tool_side_effect")
 *   - non-retryable class          → do not retry ("terminal")
 *
 * This module is intentionally pure: it only classifies. The policy that
 * *consumes* a classification — bounded backoff, circuit breaking, failover —
 * lives elsewhere and is deliberately NOT wired up by this slice (per the
 * handoff: "without changing model selection/failover behavior yet"). Here we
 * only record classifications on the child lifecycle and surface them in
 * runner diagnostics so the cause of a failure is observable and actionable.
 *
 * @see docs/HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md §4 "Recovery must preserve
 *      semantic safety" and §E "Provider circuit breaking and failover".
 */

import type { ChildPhase } from "./lifecycle.js";
import { toErrorMessage } from "../../../shared/error-message.js";

/** Typed failure class for a provider/SDK error. */
export type ProviderFailureClass =
	/** Connection-level failure with no HTTP response (ECONNRESET, ENOTFOUND,
	 *  fetch failed, socket hang up, OpenAI `APIConnectionError`). */
	| "transport"
	/** A wall-clock / idle / first-token timeout (ETIMEDOUT, "timed out",
	 *  `APIConnectionTimeoutError`, HTTP 408). */
	| "timeout"
	/** HTTP 429 / Too Many Requests. */
	| "rate_limit"
	/** HTTP 5xx server error. */
	| "server_error"
	/** Authentication / permission failure (HTTP 401/403, invalid API key). */
	| "auth"
	/** User / parent cancellation (AbortError, "aborted"). */
	| "abort"
	/** Anything not matching the above (including untyped client 4xx). */
	| "unknown";

/**
 * Phase-aware replay safety assessment. Tells the (future) recovery layer
 * whether retrying the turn from scratch is safe, and if not, why.
 */
export type ReplaySafety =
	/** Pre-output, retryable: replaying is side-effect-free. */
	| "safe"
	/** After streamed output but before any tool: replay duplicates prose. */
	| "partial_output"
	/** After a tool call / external side effect: never silently replay. */
	| "tool_side_effect"
	/** Non-retryable failure class: do not retry. */
	| "terminal";

/** Context describing how far the run had progressed when the failure hit. */
export interface FailureContext {
	/** Lifecycle phase where the failure occurred. */
	phase?: ChildPhase;
	/** Any assistant text/reasoning was already streamed (partial output). */
	hasOutput?: boolean;
	/** A tool call has started or completed — an external side effect may
	 *  already exist, so the turn must never be silently replayed. */
	hasToolSideEffects?: boolean;
}

/** The classified result returned by {@link classifyProviderError}. */
export interface ClassifiedProviderError {
	readonly class: ProviderFailureClass;
	/** Normalized human-readable message (via `toErrorMessage`). */
	readonly message: string;
	/** The original thrown value, preserved for callers that need the cause. */
	readonly cause: unknown;
	/** HTTP status code if the error carried one. */
	readonly httpStatus?: number;
	/** `Retry-After` hint in milliseconds if the response supplied one. */
	readonly retryAfterMs?: number;
	/** Whether the failure class is retryable at all (transient). */
	readonly retryable: boolean;
	/** Phase-aware replay safety for this failure + context. */
	readonly replaySafety: ReplaySafety;
	/** Lifecycle phase where the failure occurred. */
	readonly phase?: ChildPhase;
}

/** Node `errno`-style codes that indicate a transport-level failure. */
const TRANSPORT_CODES = new Set<string>([
	"ENOTFOUND",
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ECONNABORTED",
	"EPROTO",
]);

/** Node `errno`-style codes that indicate a timeout. */
const TIMEOUT_CODES = new Set<string>(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

/** Message substrings that indicate a transport-level failure. */
const TRANSPORT_RE =
	/fetch failed|socket hang up|network error|connection error|connection refused|connection reset|connection aborted|getaddrinfo|ECONN|ENOTFOUND/i;

/** Message substrings that indicate a timeout. Matches "timeout",
 *  "timed out", "time out", and "time-out". */
const TIMEOUT_RE = /\b(timed|time)[ -]?out\b|deadline exceeded|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b/i;

/** Message substrings that indicate an abort / cancellation. */
const ABORT_RE = /\boperation was aborted\b|\baborted\b|\bcancel(ed)?\b/i;

/** Message substrings that indicate an auth / permission failure. */
const AUTH_RE =
	/unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication (failed|required)|permission denied|access denied/i;

/**
 * Read an HTTP status code from a provider/SDK error if one is present.
 * Checks the common shapes across the Anthropic/OpenAI SDKs and fetch
 * responses: `status`, `statusCode`, and `httpStatus`.
 */
export function readHttpStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const e = error as Record<string, unknown>;
	const candidates = [e.status, e.statusCode, e.httpStatus];
	for (const c of candidates) {
		if (typeof c === "number") return c;
		if (typeof c === "string" && c.length > 0) {
			const n = Number(c);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}
	return undefined;
}

/**
 * Read a `Retry-After` hint (milliseconds) from a provider error's headers.
 * Handles both plain object headers and `Headers` instances. Supports:
 *   - `retry-after` (HTTP seconds, or an HTTP-date)
 *   - `retry-after-ms` (milliseconds, used by some Microsoft/Azure services)
 * The raw hint is returned uncapped; callers applying backoff are responsible
 * for bounding it. Returns `undefined` when no usable hint is present.
 */
export function readRetryAfterMs(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const headers = (error as { headers?: unknown }).headers;
	if (!headers) return undefined;

	const get = (name: string): string | undefined => {
		if (typeof headers === "object" && typeof (headers as Headers).get === "function") {
			const v = (headers as Headers).get(name);
			if (v) return v;
		}
		const h = headers as Record<string, unknown>;
		// Case-insensitive lookup for plain-object headers.
		for (const key of Object.keys(h)) {
			if (key.toLowerCase() === name.toLowerCase()) {
				const v = h[key];
				if (typeof v === "string" || typeof v === "number") return String(v);
			}
		}
		return undefined;
	};

	const ms = get("retry-after-ms");
	if (ms !== undefined) {
		const n = Number(ms);
		if (Number.isFinite(n) && n >= 0) return Math.round(n);
	}

	const seconds = get("retry-after");
	if (seconds !== undefined) {
		const n = Number(seconds);
		if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
		// HTTP-date form: compute the remaining ms from now.
		const target = Date.parse(seconds);
		if (Number.isFinite(target)) {
			const diff = target - Date.now();
			return diff > 0 ? diff : 0;
		}
	}
	return undefined;
}

/** True if the failure class is retryable at all (transient). Auth, abort,
 *  and unknown client errors are not. */
export function isRetryableFailureClass(cls: ProviderFailureClass): boolean {
	switch (cls) {
		case "transport":
		case "timeout":
		case "rate_limit":
		case "server_error":
			return true;
		case "auth":
		case "abort":
		case "unknown":
			return false;
	}
}

/** Determine the failure class from the error's shape and message. */
function determineFailureClass(error: unknown, message: string, httpStatus?: number): ProviderFailureClass {
	// HTTP-status-driven classification is the most reliable signal.
	if (httpStatus !== undefined) {
		if (httpStatus === 429) return "rate_limit";
		if (httpStatus === 408) return "timeout";
		if (httpStatus === 401 || httpStatus === 403) return "auth";
		if (httpStatus >= 500 && httpStatus < 600) return "server_error";
		// Other 4xx are client errors with no transport retry path.
		if (httpStatus >= 400 && httpStatus < 500) return "unknown";
	}

	const name = (error as { name?: unknown } | null)?.name;
	const code = (error as { code?: unknown } | null)?.code;

	// Timeout: explicit timeout error names/codes before generic abort, since
	// AbortSignal.timeout surfaces as a "TimeoutError" DOMException.
	if (typeof name === "string" && /TimeoutError|APIConnectionTimeoutError/i.test(name)) {
		return "timeout";
	}
	if (typeof code === "string" && TIMEOUT_CODES.has(code)) {
		return "timeout";
	}
	if (TIMEOUT_RE.test(message)) {
		return "timeout";
	}

	// Abort / user-or-parent cancellation.
	if (typeof name === "string" && name === "AbortError") {
		return "abort";
	}
	if (ABORT_RE.test(message)) {
		return "abort";
	}

	// Transport: connection-level errno codes / messages / SDK class names.
	if (typeof code === "string" && TRANSPORT_CODES.has(code)) {
		return "transport";
	}
	if (TRANSPORT_RE.test(message)) {
		return "transport";
	}
	if (typeof name === "string" && /APIConnectionError|ConnectionError/i.test(name)) {
		// APIConnectionTimeoutError was handled above; anything else bearing the
		// connection-error class name (no HTTP status) is a transport failure.
		return "transport";
	}

	// Auth by message (for providers that surface auth failures without a
	// status code on the thrown object).
	if (AUTH_RE.test(message)) {
		return "auth";
	}

	return "unknown";
}

/**
 * Assess replay safety for a classified failure, given how far the run had
 * progressed. The rules encode the handoff's recovery contract:
 *
 *   - After a tool call / external side effect → never silently replay
 *     (`tool_side_effect`), regardless of whether the class is retryable.
 *   - After partial output, before tools → replay duplicates prose
 *     (`partial_output`); prefer SDK-supported continuation.
 *   - Before any output → safe to retry iff the class is retryable, else
 *     `terminal` (auth / abort / unknown are not retried).
 */
export function assessReplaySafety(
	cls: ProviderFailureClass,
	context: FailureContext = {},
): ReplaySafety {
	if (context.hasToolSideEffects) return "tool_side_effect";
	if (context.hasOutput) return "partial_output";
	return isRetryableFailureClass(cls) ? "safe" : "terminal";
}

/**
 * Classify a provider/SDK error into a typed {@link ClassifiedProviderError}.
 *
 * The classification is phase-aware: pass the lifecycle phase and the
 * progress flags (output streamed? tool side effect?) so the replay-safety
 * assessment reflects how far the run had progressed when the failure hit.
 */
export function classifyProviderError(
	error: unknown,
	context: FailureContext = {},
): ClassifiedProviderError {
	const message = toErrorMessage(error);
	const httpStatus = readHttpStatus(error);
	const retryAfterMs = readRetryAfterMs(error);
	const cls = determineFailureClass(error, message, httpStatus);
	const retryable = isRetryableFailureClass(cls);
	const replaySafety = assessReplaySafety(cls, context);
	return {
		class: cls,
		message,
		cause: error,
		httpStatus,
		retryAfterMs,
		retryable,
		replaySafety,
		phase: context.phase,
	};
}
