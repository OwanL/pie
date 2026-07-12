import { createHash } from "node:crypto";
import type { LlmPruningInput } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import type { PrepassRunResult } from "./pruning-types.js";

export const PREPASS_CACHE_TTL_MS = 30 * 60 * 1000;

/** Bound on the cross-session exact-fingerprint LRU cache. Entries are reused
 *  across sessions ONLY on an exact prompt + fingerprint match (the fingerprint
 *  includes recent conversation), never on continuation prompts. 64 keeps the
 *  working set modest while covering a typical day's distinct task/catalog
 *  combinations without unbounded growth. */
export const CROSS_SESSION_CACHE_MAX = 64;

interface CachedPrepass {
	prompt: string;
	fingerprint: string;
	continuationFingerprint: string;
	createdAt: number;
	result: PrepassRunResult;
}

const cache = new Map<string, CachedPrepass>();
/** Cross-session LRU cache keyed by `fingerprint\u0000normalizedPrompt`. Map
 *  insertion order is LRU order: a hit deletes+re-sets (moves to MRU); an
 *  over-cap insert evicts the oldest (LRU) entry. */
const crossSessionCache = new Map<string, CachedPrepass>();
let now = (): number => Date.now();

/** Only whole, unambiguous continuation/retry requests are eligible for reuse. */
export function isPrepassContinuationPrompt(prompt: string): boolean {
	const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
	return /^(?:continue|proceed|go ahead|keep going|retry|try again|do it|fix (?:this|that|it))$/.test(normalized);
}

/**
 * Collapse whitespace for exact cache comparison so trivial variants (extra
 * spaces, trailing newlines from copy-paste/editing) still hit the cache
 * without changing the pruning decision. Trims and collapses internal
 * whitespace runs to a single space. Case and punctuation are preserved —
 * only the continuation matcher lowercases/strips punctuation. Applied to the
 * EXACT match path only (per-session and cross-session); continuation matching
 * is unchanged.
 */
export function normalizePromptForExactCache(prompt: string): string {
	return prompt.trim().replace(/\s+/g, " ");
}

/** Fingerprint every input that can change the candidate-scoring decision. */
export function buildPrepassFingerprint(
	input: LlmPruningInput,
	config: PruningConfig,
	includeRecentConversation = true,
): string {
	const value = {
		contextFile: input.contextFile ?? null,
		...(includeRecentConversation ? { recentConversation: input.recentConversation ?? [] } : {}),
		skills: input.skills.map(({ name, description }) => ({ name, description })),
		tools: input.tools.map(({ name, description }) => ({ name, description })),
		mode: config.mode,
		model: config.model,
		provider: config.provider,
		thinkingLevel: config.thinkingLevel,
		autoSkipBelowTokens: config.autoSkipBelowTokens ?? null,
		skillsConfig: {
			strategy: config.skills.strategy,
			ceiling: config.skills.ceiling,
			pinned: config.skills.pinned,
			alwaysKeep: config.skills.alwaysKeep,
		},
		toolsConfig: config.tools ? {
			strategy: config.tools.strategy,
			ceiling: config.tools.ceiling,
			dependencies: config.tools.dependencies,
			alwaysKeep: config.tools.alwaysKeep,
		} : null,
		prepass: config.prepass ?? null,
	};
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function getCachedPrepass(
	sessionId: string,
	prompt: string,
	fingerprint: string,
	continuationFingerprint = fingerprint,
): PrepassRunResult | null {
	const entry = cache.get(sessionId);
	if (!entry) return null;
	if (now() - entry.createdAt > PREPASS_CACHE_TTL_MS) {
		cache.delete(sessionId);
		return null;
	}
	const exactPrompt = normalizePromptForExactCache(prompt) === normalizePromptForExactCache(entry.prompt);
	if (exactPrompt ? entry.fingerprint !== fingerprint : (
		!isPrepassContinuationPrompt(prompt) || entry.continuationFingerprint !== continuationFingerprint
	)) return null;
	// A cache hit performs no provider call. Preserve the prior decision and raw
	// response, but do not duplicate provider usage or claim prompts were sent.
	return {
		...entry.result,
		rawSystemPrompt: "",
		rawUserMessage: "",
		latencyMs: 0,
		usage: undefined,
		cacheHit: true,
	};
}

export function cacheSuccessfulPrepass(
	sessionId: string,
	prompt: string,
	fingerprint: string,
	continuationFingerprint: string,
	result: PrepassRunResult,
): void {
	if (result.error || result.keptAllDueToParseFailure || result.prunedSkills === null || result.prunedTools === null) return;
	cache.set(sessionId, {
		prompt,
		fingerprint,
		continuationFingerprint,
		createdAt: now(),
		result: { ...result, cacheHit: false },
	});
}

/**
 * Cross-session exact-fingerprint LRU cache lookup. Matches ONLY on an exact
 * (whitespace-normalized) prompt + fingerprint — never on continuation
 * prompts, which are context-dependent and must not leak a decision from one
 * session into another. Returns a cache-hit result with provider-call
 * artifacts zeroed, mirroring the per-session hit shape. Promotes the entry to
 * most-recently-used on hit.
 */
export function getCachedPrepassCrossSession(
	prompt: string,
	fingerprint: string,
): PrepassRunResult | null {
	const key = crossSessionKey(fingerprint, prompt);
	const entry = crossSessionCache.get(key);
	if (!entry) return null;
	if (now() - entry.createdAt > PREPASS_CACHE_TTL_MS) {
		crossSessionCache.delete(key);
		return null;
	}
	// LRU: move to most-recently-used.
	crossSessionCache.delete(key);
	crossSessionCache.set(key, entry);
	return {
		...entry.result,
		rawSystemPrompt: "",
		rawUserMessage: "",
		latencyMs: 0,
		usage: undefined,
		cacheHit: true,
	};
}

/**
 * Store a successful prepass in the cross-session LRU cache for exact-match
 * reuse by other sessions (or this session after its per-session entry
 * expires). Parse failures and errored results are not cached. Evicts the
 * least-recently-used entry when the bound (`CROSS_SESSION_CACHE_MAX`) is
 * exceeded.
 */
export function cacheSuccessfulPrepassCrossSession(
	prompt: string,
	fingerprint: string,
	result: PrepassRunResult,
): void {
	if (result.error || result.keptAllDueToParseFailure || result.prunedSkills === null || result.prunedTools === null) return;
	const key = crossSessionKey(fingerprint, prompt);
	// LRU refresh: if present, drop so re-insert moves it to most-recently-used.
	if (crossSessionCache.has(key)) crossSessionCache.delete(key);
	crossSessionCache.set(key, {
		prompt,
		fingerprint,
		continuationFingerprint: fingerprint,
		createdAt: now(),
		result: { ...result, cacheHit: false },
	});
	if (crossSessionCache.size > CROSS_SESSION_CACHE_MAX) {
		const oldest = crossSessionCache.keys().next().value;
		if (oldest !== undefined) crossSessionCache.delete(oldest);
	}
}

/** Composite key for the cross-session cache: fingerprint + NUL + normalized
 *  prompt. NUL cannot appear in a prompt string, so the pair is unambiguous. */
function crossSessionKey(fingerprint: string, prompt: string): string {
	return `${fingerprint}\u0000${normalizePromptForExactCache(prompt)}`;
}

/** Test seam: clear one session (per-session only) or the entire per-session +
 *  cross-session cache. */
export function clearPrepassCacheForTesting(sessionId?: string): void {
	if (sessionId) cache.delete(sessionId);
	else {
		cache.clear();
		crossSessionCache.clear();
	}
}

/** Test seam for deterministic TTL coverage. */
export function setPrepassCacheNowForTesting(value: (() => number) | null): void {
	now = value ?? (() => Date.now());
}
