import { createHash } from "node:crypto";
import type { LlmPruningInput } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import type { PrepassRunResult } from "./pruning-types.js";

export const PREPASS_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedPrepass {
	prompt: string;
	fingerprint: string;
	continuationFingerprint: string;
	createdAt: number;
	result: PrepassRunResult;
}

const cache = new Map<string, CachedPrepass>();
let now = (): number => Date.now();

/** Only whole, unambiguous continuation/retry requests are eligible for reuse. */
export function isPrepassContinuationPrompt(prompt: string): boolean {
	const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
	return /^(?:continue|proceed|go ahead|keep going|retry|try again|do it|fix (?:this|that|it))$/.test(normalized);
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
	const exactPrompt = prompt === entry.prompt;
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

/** Test seam: clear one session or the entire cache. */
export function clearPrepassCacheForTesting(sessionId?: string): void {
	if (sessionId) cache.delete(sessionId);
	else cache.clear();
}

/** Test seam for deterministic TTL coverage. */
export function setPrepassCacheNowForTesting(value: (() => number) | null): void {
	now = value ?? (() => Date.now());
}
