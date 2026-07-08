export type PruningMode = "auto" | "off" | "shadow";

export type PruningStrategy = "discretion" | "topK";

export interface SkillPruningConfig {
	strategy: PruningStrategy;
	ceiling: number;
	pinned: string[];
	alwaysKeep: string[];
}

export type ToolDependencies = Record<string, string[]>;

export interface ToolPruningConfig {
	strategy: PruningStrategy;
	ceiling: number;
	dependencies: ToolDependencies;
	alwaysKeep: string[];
}

/**
 * Tunable knobs for the LLM prepass call itself (timeouts + retry budgets).
 * Every field is optional: an absent field falls back to the built-in default
 * in `src/prepass.ts` (see `LLM_TIMEOUT_MS_BY_THINKING_LEVEL`,
 * `PREPASS_MAX_TRANSPORT_RETRIES`, `PREPASS_TRANSPORT_BACKOFF_BASE_MS`,
 * `OAUTH_RACE_BACKOFF_MS`). This keeps the prepass self-tuning out of the box
 * while letting operators override individual budgets without restating the
 * whole map.
 */
export interface PrepassConfig {
	/**
	 * Per-thinking-level timeout ceiling (ms) for ONE prepass model call.
	 * These are ceilings, not waits: a call that completes early returns
	 * immediately. Merged over the built-in defaults, so a partial map (e.g.
	 * `{ "minimal": 20000 }`) overrides only that level and keeps the rest.
	 * Invalid entries (non-positive numbers) are dropped with a warning.
	 */
	timeoutMs?: Record<string, number>;
	/**
	 * Max transport-level retries (5xx / 429 / network) per thinking-level
	 * attempt, with exponential backoff between them. `0` disables prepass-
	 * level transport retrying (pi-ai's own `maxRetries` is still forwarded).
	 */
	maxTransportRetries?: number;
	/**
	 * Base (ms) for the exponential backoff between transport retries
	 * (`base * 2**(attempt-1)`). `0` retries immediately with no delay.
	 */
	transportBackoffBaseMs?: number;
	/**
	 * Backoff (ms) for the github-copilot OAuth-token race in `resolveAuth`.
	 * The prepass runs in `before_agent_start`, before the main agent's first
	 * call triggers the lazy OAuth refresh; re-resolving after this delay
	 * bridges that window. `0` skips the re-resolve.
	 */
	oauthRaceBackoffMs?: number;
}

export interface PruningConfig {
	mode: PruningMode;
	model: string;
	provider: string;
	thinkingLevel: string;
	skills: SkillPruningConfig;
	tools?: ToolPruningConfig;
	prepass?: PrepassConfig;
}

export interface PruningResult {
	includedSkills: string[];
	excludedSkills: string[];
	includedTools: string[];
	excludedTools: string[];
	mode: PruningMode;
	skillTokensSaved: number;
	toolTokensSaved: number;
	/** Model used for the LLM prepass call. */
	prepassModel?: string;
	/** Thinking level of the LLM prepass call. */
	prepassThinkingLevel?: string;
	/** Raw LLM response text. */
	prepassResponse?: string;
	/** Raw thinking/reasoning tokens from the prepass LLM call. */
	prepassThinking?: string;
	/** System prompt sent to the LLM prepass. */
	prepassSystemPrompt?: string;
	/** User message (candidate list prompt) sent to the LLM prepass. */
	prepassUserMessage?: string;
	/** Latency of the LLM prepass call in milliseconds. */
	prepassLatencyMs?: number;
	/** Token usage reported by the LLM prepass call, when available. */
	prepassInputTokens?: number;
	prepassOutputTokens?: number;
	prepassCacheReadTokens?: number;
	prepassCacheWriteTokens?: number;
	/** Error message if the prepass failed. */
	prepassError?: string;
	/** Human-readable explanation of why the pruner kept a category instead of trusting the model. */
	prepassSafeguardReason?: string;
}

export interface PruningDecision {
	timestamp: string;
	sessionId: string;
	sessionPath: string;
	mode: PruningMode;
	query: string;
	contextFile?: string;
	llmModel: string;
	llmThinkingLevel: string;
	llmResponse: string;
	llmLatencyMs: number;
	pinned: string[];
	included: string[];
	excluded: string[];
	skillBlockTokens: number;
	originalBlockTokens: number;
	toolIncluded?: string[];
	toolExcluded?: string[];
	toolBlockTokens?: number;
	originalToolBlockTokens?: number;
	/** True when the prepass response was unreadable as JSON → kept all (parse failure). */
	keptAllDueToParseFailure?: boolean;
}
