/**
 * Focused unit tests for provider failure classification and phase-aware
 * replay safety (handoff slice: "Provider classification/circuit breaker",
 * classification-only — no retry/failover behaviour wired up).
 *
 * @see docs/HANDOFF_SUBAGENT_PROVIDER_RESILIENCE.md §4 & §E
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyProviderError,
	assessReplaySafety,
	isRetryableFailureClass,
	readHttpStatus,
	readRetryAfterMs,
	type ProviderFailureClass,
} from "../src/provider-failure.js";
import { ChildLifecycle, DEFAULT_LIVENESS_CONFIG } from "../src/lifecycle.js";

/** Build a minimal error-like object. */
function err(shape: Record<string, unknown>): Error & Record<string, unknown> {
	return Object.assign(new Error("err"), shape);
}

// ---------------------------------------------------------------------------
// Failure-class classification
// ---------------------------------------------------------------------------

test("transport: connection-level errno codes classify as transport and are retryable", () => {
	for (const code of ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]) {
		const c = classifyProviderError(err({ code, message: `getaddrinfo ${code} host` }));
		assert.equal(c.class, "transport", `${code} should be transport`);
		assert.equal(c.retryable, true);
		assert.equal(c.replaySafety, "safe", "pre-output transport is safe to retry");
	}
});

test("transport: SDK connection-error messages and class names classify as transport", () => {
	const cases = [
		err({ message: "fetch failed" }),
		err({ message: "socket hang up" }),
		err({ message: "Connection error." }),
		err({ name: "APIConnectionError", message: "Connection error." }),
		err({ name: "APIConnectionError", message: "Connection error.", cause: err({ code: "ECONNRESET" }) }),
	];
	for (const e of cases) {
		const c = classifyProviderError(e);
		assert.equal(c.class, "transport");
		assert.equal(c.retryable, true);
	}
});

test("timeout: ETIMEDOUT code, timeout messages, and TimeoutError name classify as timeout", () => {
	const cases: Array<Error & Record<string, unknown>> = [
		err({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }),
		err({ code: "ESOCKETTIMEDOUT", message: "socket timed out" }),
		err({ message: "Request timed out" }),
		err({ message: "deadline exceeded" }),
		err({ name: "TimeoutError", message: "The operation timed out" }),
		err({ name: "APIConnectionTimeoutError", message: "Request timed out" }),
	];
	for (const e of cases) {
		const c = classifyProviderError(e);
		assert.equal(c.class, "timeout", `${e.message} should be timeout`);
		assert.equal(c.retryable, true);
	}
});

test("timeout: HTTP 408 classifies as timeout", () => {
	const c = classifyProviderError(err({ status: 408, message: "Request Timeout" }));
	assert.equal(c.class, "timeout");
	assert.equal(c.retryable, true);
	assert.equal(c.httpStatus, 408);
});

test("rate_limit: HTTP 429 classifies as rate_limit and is retryable", () => {
	const c = classifyProviderError(err({ status: 429, message: "Too Many Requests" }));
	assert.equal(c.class, "rate_limit");
	assert.equal(c.retryable, true);
	assert.equal(c.httpStatus, 429);
	assert.equal(c.retryAfterMs, undefined, "no Retry-After header → undefined");
});

test("rate_limit: Retry-After seconds header is parsed to ms", () => {
	const c = classifyProviderError(
		err({ status: 429, message: "Too Many Requests", headers: { "retry-after": "20" } }),
	);
	assert.equal(c.class, "rate_limit");
	assert.equal(c.retryAfterMs, 20_000);
});

test("rate_limit: retry-after-ms header is parsed directly to ms", () => {
	const c = classifyProviderError(
		err({ status: 429, message: "Too Many Requests", headers: { "retry-after-ms": "1500" } }),
	);
	assert.equal(c.retryAfterMs, 1500);
});

test("rate_limit: Headers instance (fetch) is supported for Retry-After", () => {
	const headers = new Headers({ "retry-after": "5" });
	const c = classifyProviderError(err({ status: 429, message: "429", headers }));
	assert.equal(c.retryAfterMs, 5_000);
});

test("server_error: 5xx classifies as server_error and is retryable", () => {
	for (const status of [500, 502, 503, 504]) {
		const c = classifyProviderError(err({ status, message: `${status} error` }));
		assert.equal(c.class, "server_error", `${status} should be server_error`);
		assert.equal(c.retryable, true);
		assert.equal(c.httpStatus, status);
	}
});

test("auth: 401/403 classifies as auth and is NOT retryable", () => {
	for (const status of [401, 403]) {
		const c = classifyProviderError(err({ status, message: `${status}` }));
		assert.equal(c.class, "auth", `${status} should be auth`);
		assert.equal(c.retryable, false);
		assert.equal(c.replaySafety, "terminal", "pre-output auth is terminal (not retried)");
	}
});

test("auth: auth messages without a status still classify as auth", () => {
	const cases = [
		err({ message: "Invalid API key provided" }),
		err({ message: "Unauthorized: bad token" }),
		err({ message: "permission denied for resource" }),
	];
	for (const e of cases) {
		const c = classifyProviderError(e);
		assert.equal(c.class, "auth");
		assert.equal(c.retryable, false);
	}
});

test("abort: AbortError name and 'aborted' message classify as abort and are NOT retryable", () => {
	const e = err({ name: "AbortError", message: "The operation was aborted" });
	const c = classifyProviderError(e);
	assert.equal(c.class, "abort");
	assert.equal(c.retryable, false);
	assert.equal(c.replaySafety, "terminal");
});

test("abort: TimeoutError is classified as timeout, NOT abort (AbortSignal.timeout shape)", () => {
	// AbortSignal.timeout surfaces as a DOMException named "TimeoutError" — it
	// must be a timeout, not a user abort.
	const c = classifyProviderError(err({ name: "TimeoutError", message: "The operation timed out" }));
	assert.equal(c.class, "timeout");
});

test("unknown: untyped client 4xx and unmatched errors classify as unknown (not retryable)", () => {
	const c4xx = classifyProviderError(err({ status: 400, message: "bad request" }));
	assert.equal(c4xx.class, "unknown");
	assert.equal(c4xx.retryable, false);
	assert.equal(c4xx.httpStatus, 400);

	const cBare = classifyProviderError(err({ message: "something weird happened" }));
	assert.equal(cBare.class, "unknown");
	assert.equal(cBare.retryable, false);
});

test("classification preserves message, cause, and phase from context", () => {
	const e = err({ status: 500, message: "boom" });
	const c = classifyProviderError(e, { phase: "streaming" });
	assert.equal(c.message, "boom");
	assert.equal(c.cause, e);
	assert.equal(c.phase, "streaming");
});

// ---------------------------------------------------------------------------
// Replay safety matrix (phase-aware)
// ---------------------------------------------------------------------------

test("replay safety: before any output, retryable → safe", () => {
	assert.equal(
		assessReplaySafety("transport", { hasOutput: false, hasToolSideEffects: false }),
		"safe",
	);
	assert.equal(
		assessReplaySafety("rate_limit", {}),
		"safe",
	);
});

test("replay safety: before any output, non-retryable → terminal", () => {
	assert.equal(
		assessReplaySafety("auth", { hasOutput: false, hasToolSideEffects: false }),
		"terminal",
	);
	assert.equal(assessReplaySafety("abort", {}), "terminal");
	assert.equal(assessReplaySafety("unknown", {}), "terminal");
});

test("replay safety: after partial output, before tools → partial_output", () => {
	for (const cls of ["transport", "rate_limit", "server_error", "timeout"] as ProviderFailureClass[]) {
		assert.equal(
			assessReplaySafety(cls, { hasOutput: true, hasToolSideEffects: false }),
			"partial_output",
			`${cls} after output should be partial_output`,
		);
	}
	// Even non-retryable classes after output are partial_output, not terminal:
	// the safety describes what a replay WOULD cost, and the partial transcript
	// must be preserved regardless.
	assert.equal(
		assessReplaySafety("auth", { hasOutput: true, hasToolSideEffects: false }),
		"partial_output",
	);
});

test("replay safety: after a tool side effect → tool_side_effect (never silently replay)", () => {
	// Takes precedence over partial_output AND over retryability.
	for (const cls of [
		"transport",
		"rate_limit",
		"server_error",
		"timeout",
		"auth",
		"abort",
		"unknown",
	] as ProviderFailureClass[]) {
		assert.equal(
			assessReplaySafety(cls, { hasToolSideEffects: true }),
			"tool_side_effect",
			`${cls} after a tool must be tool_side_effect`,
		);
	}
	// Tool side effect wins over partial output too.
	assert.equal(
		assessReplaySafety("transport", { hasOutput: true, hasToolSideEffects: true }),
		"tool_side_effect",
	);
});

test("classifyProviderError threads replay safety from context", () => {
	const transport = err({ code: "ECONNRESET", message: "connection reset" });
	assert.equal(classifyProviderError(transport).replaySafety, "safe");
	assert.equal(classifyProviderError(transport, { hasOutput: true }).replaySafety, "partial_output");
	assert.equal(
		classifyProviderError(transport, { hasOutput: true, hasToolSideEffects: true }).replaySafety,
		"tool_side_effect",
	);
	assert.equal(classifyProviderError(transport, { hasToolSideEffects: true }).replaySafety, "tool_side_effect");
});

// ---------------------------------------------------------------------------
// isRetryableFailureClass / readHttpStatus / readRetryAfterMs
// ---------------------------------------------------------------------------

test("isRetryableFailureClass: transport/timeout/rate_limit/server_error retryable; auth/abort/unknown not", () => {
	assert.equal(isRetryableFailureClass("transport"), true);
	assert.equal(isRetryableFailureClass("timeout"), true);
	assert.equal(isRetryableFailureClass("rate_limit"), true);
	assert.equal(isRetryableFailureClass("server_error"), true);
	assert.equal(isRetryableFailureClass("auth"), false);
	assert.equal(isRetryableFailureClass("abort"), false);
	assert.equal(isRetryableFailureClass("unknown"), false);
});

test("readHttpStatus: reads status / statusCode / httpStatus, numeric or string", () => {
	assert.equal(readHttpStatus(err({ status: 429 })), 429);
	assert.equal(readHttpStatus(err({ statusCode: "503" })), 503);
	assert.equal(readHttpStatus(err({ httpStatus: 401 })), 401);
	assert.equal(readHttpStatus(err({ message: "no status" })), undefined);
	assert.equal(readHttpStatus(null), undefined);
	assert.equal(readHttpStatus("string"), undefined);
});

test("readRetryAfterMs: seconds, ms, and HTTP-date forms; undefined when absent", () => {
	assert.equal(readRetryAfterMs(err({ headers: { "retry-after": "30" } })), 30_000);
	assert.equal(readRetryAfterMs(err({ headers: { "retry-after-ms": "250" } })), 250);
	assert.equal(readRetryAfterMs(err({ headers: { "Retry-After": "12" } })), 12_000, "case-insensitive");
	// HTTP-date form: a future date yields a positive remaining ms.
	const future = new Date(Date.now() + 60_000).toUTCString();
	const ms = readRetryAfterMs(err({ headers: { "retry-after": future } }));
	assert.ok(typeof ms === "number" && ms > 0 && ms <= 60_000, "future HTTP-date should be positive");
	assert.equal(readRetryAfterMs(err({ headers: {} })), undefined);
	assert.equal(readRetryAfterMs(err({ message: "no headers" })), undefined);
});

// ---------------------------------------------------------------------------
// ChildLifecycle.fail integration: classification is recorded, phase-aware
// ---------------------------------------------------------------------------

test("ChildLifecycle.fail records a classified error with phase and replay safety from progress", () => {
	const lc = new ChildLifecycle("a-1", DEFAULT_LIVENESS_CONFIG);
	lc.transition("preparing");
	// A pre-spawn transport failure: no output, no tool → safe.
	const ok = lc.fail(err({ code: "ECONNRESET", message: "connection reset" }));
	assert.equal(ok, true);
	assert.equal(lc.classified?.class, "transport");
	assert.equal(lc.classified?.retryable, true);
	assert.equal(lc.classified?.replaySafety, "safe");
	assert.equal(lc.classified?.phase, "preparing", "phase recorded at failure time, not mutated to 'failed'");
	assert.equal(lc.phase, "failed");
});

test("ChildLifecycle.fail after streaming records partial_output replay safety", () => {
	const lc = new ChildLifecycle("a-2", DEFAULT_LIVENESS_CONFIG);
	lc.transition("waiting_provider");
	lc.transition("streaming"); // sticky hasOutput = true
	lc.fail(err({ status: 429, message: "Too Many Requests", headers: { "retry-after": "5" } }));
	assert.equal(lc.classified?.class, "rate_limit");
	assert.equal(lc.classified?.replaySafety, "partial_output");
	assert.equal(lc.classified?.retryAfterMs, 5_000);
	assert.equal(lc.classified?.phase, "streaming");
});

test("ChildLifecycle.fail after a tool side effect records tool_side_effect (never replay)", () => {
	const lc = new ChildLifecycle("a-3", DEFAULT_LIVENESS_CONFIG);
	lc.transition("streaming");
	lc.transition("running_tool"); // sticky hasToolSideEffects = true
	lc.fail(err({ status: 500, message: "boom" }));
	assert.equal(lc.classified?.class, "server_error");
	assert.equal(lc.classified?.replaySafety, "tool_side_effect");
	assert.equal(lc.classified?.phase, "running_tool");
});

test("ChildLifecycle.fail second call is a no-op and preserves the first classification", () => {
	const lc = new ChildLifecycle("a-4", DEFAULT_LIVENESS_CONFIG);
	lc.transition("streaming");
	assert.equal(lc.fail(err({ status: 429, message: "429" })), true);
	const first = lc.classified;
	assert.equal(first?.class, "rate_limit");
	// A late second fail() must not overwrite the recorded classification.
	assert.equal(lc.fail(err({ code: "ECONNRESET", message: "late" })), false);
	assert.equal(lc.classified, first, "classification from first fail() is preserved");
	assert.equal(lc.classified?.class, "rate_limit");
});

test("ChildLifecycle terminal transitions other than fail() do not set classified", () => {
	const lc = new ChildLifecycle("a-5", DEFAULT_LIVENESS_CONFIG);
	lc.transition("streaming");
	assert.equal(lc.cancel("user stopped"), true);
	assert.equal(lc.classified, undefined, "cancel() is not a provider failure → no classification");

	const lc2 = new ChildLifecycle("a-6", DEFAULT_LIVENESS_CONFIG);
	lc2.transition("streaming");
	assert.equal(lc2.finish({} as never), true);
	assert.equal(lc2.classified, undefined, "finish() is not a failure → no classification");
});
