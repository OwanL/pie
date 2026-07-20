/**
 * Type definitions shared across the skill-pruner source modules.
 *
 * `pruning.ts` declares the *interfaces* for the data it produces, but
 * those types are also referenced by `message-builders.ts` (which only
 * consumes the values) and the `register.ts` orchestrator. Putting them
 * here keeps the modules from forming an import cycle.
 */

export interface SkillPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

export interface ToolPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

export interface PrepassUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reportedCostUsd?: number;
}

export interface PrepassRunResult {
	/** Skills the LLM chose to prune (null = no usable prepass signal → keep all). */
	prunedSkills: string[] | null;
	/** Tools the LLM chose to prune (null = no usable prepass signal → keep all). */
	prunedTools: string[] | null;
	error: string | null;
	rawResponse: string;
	rawThinking: string;
	rawSystemPrompt: string;
	rawUserMessage: string;
	latencyMs: number;
	thinkingLevel: string;
	usage?: PrepassUsage;
	/** True when the prepass response was unreadable as JSON → kept all (parse failure). */
	keptAllDueToParseFailure?: boolean;
	/** True when this result was reused from the per-session cache. */
	cacheHit?: boolean;
}
