/**
 * REM-03 retry/attempt semantics: bounded per-attempt analytics, provider-aware
 * failover, Retry-After/backoff parsing, and abortable waits.
 *
 * This module keeps the deterministic policy/clock seams in one place so the
 * retry loop in single.ts can be tested with an injected clock.
 */

import type { ModelProviderRef } from "./provider-toggles.js";
import { parseModelSpec, qualifiedModelSpec } from "./bucket-config.js";
import type { SingleResult, SubagentAttemptPhase, SubagentAttemptRecord, UsageStats } from "../types.js";

/** Cancelable timer handle returned by {@link RetryClock.setTimer}. */
export interface RetryTimer {
	promise: Promise<void>;
	cancel: () => void;
}

/** Clock and timer abstraction so tests can inject deterministic control. */
export interface RetryClock {
	now(): number;
	setTimer(ms: number): RetryTimer;
}

/** Real clock/timer used in production. */
export const realRetryClock: RetryClock = {
	now: () => Date.now(),
	setTimer: (ms) => {
		let handle: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<void>((resolve) => {
			handle = setTimeout(resolve, ms);
		});
		return {
			promise,
			cancel: () => {
				if (handle) {
					clearTimeout(handle);
					handle = undefined;
				}
			},
		};
	},
};

/** Retry policy constants. */
export interface RetryPolicy {
	/** Initial exponential-backoff delay in milliseconds. */
	initialRetryMs: number;
	/** Maximum exponential-backoff delay in milliseconds. */
	maxRetryMs: number;
	/** Exponential backoff multiplier. */
	retryMultiplier: number;
	/** Maximum parsed Retry-After delay in milliseconds. */
	maxRetryAfterMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
	initialRetryMs: 1_000,
	maxRetryMs: 60_000,
	retryMultiplier: 2,
	maxRetryAfterMs: 120_000,
};

const INITIAL_RETRY_ENV = "PIE_SUBAGENT_RETRY_INITIAL_MS";
const MAX_RETRY_ENV = "PIE_SUBAGENT_RETRY_MAX_MS";
const MULTIPLIER_ENV = "PIE_SUBAGENT_RETRY_MULTIPLIER";
const MAX_RETRY_AFTER_ENV = "PIE_SUBAGENT_RETRY_AFTER_MAX_MS";

function readFiniteEnv(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the active retry policy from environment overrides. */
export function readRetryPolicy(): RetryPolicy {
	return {
		initialRetryMs: readFiniteEnv(INITIAL_RETRY_ENV, DEFAULT_RETRY_POLICY.initialRetryMs),
		maxRetryMs: readFiniteEnv(MAX_RETRY_ENV, DEFAULT_RETRY_POLICY.maxRetryMs),
		retryMultiplier: readFiniteEnv(MULTIPLIER_ENV, DEFAULT_RETRY_POLICY.retryMultiplier),
		maxRetryAfterMs: readFiniteEnv(MAX_RETRY_AFTER_ENV, DEFAULT_RETRY_POLICY.maxRetryAfterMs),
	};
}

/** Zero usage stats for synthetic budget-exhausted / no-eligible-model results. */
export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Parse a Retry-After hint from a provider/SDK error.
 *
 * Recognized shapes:
 * - error.retryAfter (number, seconds or ms when > 1e10 treated as ms)
 * - error.headers['retry-after'] (string seconds or HTTP date)
 * - error.response.headers['retry-after'] (same)
 * - error.retryAfterMs (number ms)
 *
 * The result is clamped to the policy maximum. Returns undefined when no
 * recognizable hint is present.
 */
export function parseRetryAfterMs(error: unknown, policy: RetryPolicy, now: number | RetryClock = Date.now()): number | undefined {
	const nowMs = typeof now === "number" ? now : now.now();
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;

	// Direct numeric fields.
	const directMs = numericMs(record.retryAfterMs);
	if (directMs !== undefined) return clampRetryAfter(directMs, policy);

	const retryAfter = record.retryAfter;
	if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
		// Retry-After is conventionally seconds, but some SDKs already return ms.
		const ms = retryAfter > 1e10 ? retryAfter : retryAfter * 1000;
		return clampRetryAfter(ms, policy);
	}

	// Header shapes.
	const headerValue = headerRetryAfter(record);
	if (headerValue !== undefined) {
		const parsed = parseHeaderRetryAfter(headerValue, nowMs);
		if (parsed !== undefined) return clampRetryAfter(parsed, policy);
	}

	return undefined;
}

function numericMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	return undefined;
}

function headerRetryAfter(record: Record<string, unknown>): string | undefined {
	const headers = extractHeaders(record.headers) ?? extractHeaders(record.response);
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === "retry-after") {
			if (typeof value === "string") return value;
			if (typeof value === "number") return String(value);
		}
	}
	return undefined;
}

function extractHeaders(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const headers = (value as Record<string, unknown>).headers;
	if (headers && typeof headers === "object" && !Array.isArray(headers)) return headers as Record<string, unknown>;
	return value as Record<string, unknown>;
}

function parseHeaderRetryAfter(value: string, now = Date.now()): number | undefined {
	const trimmed = value.trim();
	const asSeconds = Number(trimmed);
	if (!Number.isNaN(asSeconds) && Number.isFinite(asSeconds) && asSeconds >= 0) {
		return asSeconds * 1000;
	}
	// Recognize HTTP-date (Retry-After: <http-date>).
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return date - now;
	return undefined;
}

export function clampRetryAfter(ms: number, policy: RetryPolicy): number {
	return Math.max(0, Math.min(policy.maxRetryAfterMs, Math.floor(ms)));
}

/** Bounded exponential backoff for a retry attempt. */
export function computeBackoffMs(attemptsMade: number, policy: RetryPolicy): number {
	const ms = policy.initialRetryMs * Math.pow(policy.retryMultiplier, attemptsMade);
	return Math.min(policy.maxRetryMs, Math.floor(ms));
}

/**
 * Wait for `ms` milliseconds, rejecting immediately if `signal` aborts.
 * Uses the injected clock so tests can advance time deterministically.
 */
export function abortableDelay(ms: number, signal: AbortSignal | undefined, clock: RetryClock): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new Error("Retry delay aborted"));
	}
	if (!signal) {
		return clock.setTimer(ms).promise;
	}
	return new Promise<void>((resolve, reject) => {
		const timer = clock.setTimer(ms);
		const onAbort = () => {
			timer.cancel();
			reject(new Error("Retry delay aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		timer.promise.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** Resolve the provider that owns a model spec. Qualified specs are exact;
 * legacy bare ids retain the historical registry lookup. */
export function providerForModel(modelId: string, registryModels: ModelProviderRef[] | undefined): string | undefined {
	const spec = parseModelSpec(modelId);
	if (spec.provider) return spec.provider;
	if (!registryModels) return undefined;
	return registryModels.find((m) => m.id === spec.id)?.provider;
}

/** Add every configured model from a provider to an exclusion set. Both forms
 * are recorded: bare ids preserve legacy retry semantics, while exact specs
 * prevent one failed provider from excluding a qualified duplicate elsewhere. */
export function excludeProviderModels(
	provider: string,
	registryModels: ModelProviderRef[] | undefined,
	excludeModels: Set<string>,
): void {
	if (!registryModels) return;
	for (const model of registryModels) {
		if (model.provider !== provider) continue;
		excludeModels.add(model.id);
		excludeModels.add(qualifiedModelSpec(model.provider, model.id));
	}
}

const ATTEMPT_PHASES: readonly SubagentAttemptPhase[] = [
	"queued", "preparing", "waiting_provider", "streaming", "running_tool", "orphaned_cleanup",
];

/** Copy only finite, fixed-key producer timing evidence into the terminal
 * record. This keeps the parent-facing payload bounded even if a result was
 * assembled by an extension/test seam rather than runner.ts. */
function safePhaseDurations(value: SingleResult["phaseDurationsMs"]): SubagentAttemptRecord["phaseDurationsMs"] {
	if (!value) return undefined;
	const copied: Partial<Record<SubagentAttemptPhase, number>> = {};
	for (const phase of ATTEMPT_PHASES) {
		const duration = value[phase];
		if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
			copied[phase] = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(duration));
		}
	}
	return Object.keys(copied).length > 0 ? copied : undefined;
}

/** Derive the per-attempt analytics record from a completed attempt result. */
export function buildAttemptRecord(result: SingleResult, backoffMs?: number): SubagentAttemptRecord {
	const outcome: SubagentAttemptRecord["outcome"] =
		result.exitCode === 0 ? "success" : result.stopReason === "aborted" ? "aborted" : "failure";
	const phaseDurationsMs = safePhaseDurations(result.phaseDurationsMs);
	return {
		attemptId: result.attemptId ?? "unknown",
		provider: result.provider,
		// Prefer the selected model id so analytics reflect the configured/requested
		// attempt target even when the SDK runtime stamps a different actual model.
		model: result.selectedModel ?? result.model,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
		outcome,
		failureClass: result.failureClass,
		replaySafety: result.replaySafety,
		backoffMs,
		providerResponseObserved: (result.providerInvocations?.length ?? 0) > 0,
		usage: result.usage,
		...(phaseDurationsMs ? { phaseDurationsMs } : {}),
		attemptSettlementOutcome: result.stopReason ?? result.activityPhase,
		cleanupOutcome: undefined,
	};
}
