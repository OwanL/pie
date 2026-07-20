/**
 * Pure builders for the strings and records that the skill-pruner emits
 * back into the agent (PruningResult, PruningDecision, feedback message,
 * prompt-block replacement, etc.).
 *
 * These helpers take already-resolved data and produce immutable values
 * with no side effects. Keeping them separate from `pruning.ts` makes
 * the orchestrator easier to read and lets tests target the
 * "shape of output" without standing up the full prepass flow.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateTokens } from "../logger.js";
import { countTokens } from "../tokenize.js";
import type { PruningConfig, PruningDecision, PruningResult } from "../types.js";

import type { PrepassUsage, SkillPruningResult, ToolPruningResult } from "./pruning-types.js";

export interface PrepassDiagnostics {
	model: string;
	provider?: string;
	thinkingLevel: string;
	response: string;
	thinking: string;
	systemPrompt: string;
	userMessage: string;
	latencyMs: number;
	usage?: PrepassUsage;
	cacheHit?: boolean;
	error?: string | null;
	safeguardReason?: string | null;
}

function applyPrepassUsage(details: PruningResult, usage: PrepassUsage | undefined): void {
	if (!usage) return;
	details.prepassInputTokens = usage.input;
	details.prepassOutputTokens = usage.output;
	details.prepassCacheReadTokens = usage.cacheRead;
	details.prepassCacheWriteTokens = usage.cacheWrite;
	if (usage.reportedCostUsd !== undefined) details.prepassReportedCostUsd = usage.reportedCostUsd;
}

/**
 * Render prepass latency as a compact `· prepass Xs` / `· prepass Xms` note.
 * Returns "" when there is no latency to report. Surfacing this lets the user
 * distinguish a genuinely slow prepass (often a slow provider TTFT, since the
 * prepass makes its own model call) from a normal keep-all outcome — the
 * keep-all result itself is *expected* under the keep-biased design and is
 * not a warning.
 */
export function formatLatencyNote(latencyMs: number | undefined): string {
	if (!latencyMs || latencyMs <= 0) return "";
	if (latencyMs >= 1000) {
		const seconds = latencyMs / 1000;
		return ` · prepass ${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
	}
	return ` · prepass ${latencyMs}ms`;
}

/** Display shape returned from `buildFeedbackMessage`. */
export interface PruningFeedbackMessage {
	customType: "pruning-result";
	content: string;
	display: boolean;
	details: PruningResult;
}

/**
 * Compose the final PruningResult envelope plus optional audit decision.
 */
export function buildPruningPayload(
	skillResult: SkillPruningResult | null,
	toolResult: ToolPruningResult | null,
	activeConfig: PruningConfig,
	pruningError: string | null,
	latencyMs: number,
	prepassThinkingLevel: string,
	rawResponse: string,
	rawThinking: string,
	rawSystemPrompt: string,
	rawUserMessage: string,
	skillSafeguardReason?: string | null,
	toolSafeguardReason?: string | null,
	_excludedSkillPaths?: string[],
	_includedSkillPaths?: string[],
): { result: PruningResult; decision?: PruningDecision } {
	const safeguardReason = (skillSafeguardReason && toolSafeguardReason)
		? `${skillSafeguardReason} · ${toolSafeguardReason}`
		: (skillSafeguardReason ?? toolSafeguardReason ?? undefined);

	const result: PruningResult = {
		includedSkills: skillResult?.included ?? [],
		excludedSkills: skillResult?.excluded ?? [],
		includedTools: toolResult?.included ?? [],
		excludedTools: toolResult?.excluded ?? [],
		mode: activeConfig.mode,
		skillTokensSaved: skillResult?.tokensSaved ?? 0,
		toolTokensSaved: toolResult?.tokensSaved ?? 0,
		prepassModel: activeConfig.model,
		prepassThinkingLevel: prepassThinkingLevel,
		prepassResponse: rawResponse || undefined,
		prepassThinking: rawThinking || undefined,
		prepassSystemPrompt: rawSystemPrompt || undefined,
		prepassUserMessage: rawUserMessage || undefined,
		prepassLatencyMs: latencyMs,
		prepassError: pruningError || undefined,
		prepassSafeguardReason: safeguardReason,
	};

	return { result };
}

/** Hidden skill names are disclosed only through request_capability polling. */
export function buildHint(_excludedNames: string[]): string {
	return "";
}

/**
 * Strip a single leading blank line, then re-prefix with two newlines so
 * the new skill block slots cleanly into the surrounding system prompt.
 * The hint is appended when present.
 */
export function buildReplacement(newBlock: string, hint: string): string {
	const stripped = newBlock.replace(/^\n\n/, "");
	if (hint === "") {
		return `\n\n${stripped}`;
	}
	return `\n\n${stripped}\n${hint}`;
}

/**
 * Capture a PruningDecision for the audit log. Token counts come from the
 * real cl100k_base BPE tokenizer shared with the logger (chars/4 fallback
 * only when the tokenizer cannot be resolved in the current runtime).
 */
export function buildDecision(input: {
	sessionId: string;
	sessionPath: string;
	mode: PruningConfig["mode"];
	query: string;
	contextFilePath?: string;
	llmModel: string;
	llmThinkingLevel: string;
	llmResponse: string;
	llmLatencyMs: number;
	included: string[];
	excluded: string[];
	pinned: string[];
	newBlock: string;
	originalBlock: string;
	/** Tool names kept this turn (undefined when tool pruning did not run). */
	toolIncluded?: string[];
	/** Tool names pruned this turn (undefined when tool pruning did not run). */
	toolExcluded?: string[];
	/** Estimated tokens of the kept tool descriptions. */
	toolBlockTokens?: number;
	/** Estimated tokens of the original (pre-prune) tool descriptions. */
	originalToolBlockTokens?: number;
	/** True when the prepass response was unreadable as JSON → kept all (parse failure). */
	keptAllDueToParseFailure?: boolean;
	/** Provider-reported token usage for the prepass call (when available). */
	prepassUsage?: PrepassUsage;
	/** System prompt sent to the prepass LLM (for the local input-size estimate). */
	prepassSystemPrompt?: string;
	/** User message sent to the prepass LLM (for the local input-size estimate). */
	prepassUserMessage?: string;
	/** Short git SHA tagging the pruning-code version that produced this decision. */
	codeVersion?: string;
	/** True when a prior successful prepass was reused. */
	cacheHit?: boolean;
}): PruningDecision {
	return {
		timestamp: new Date().toISOString(),
		sessionId: input.sessionId,
		sessionPath: input.sessionPath,
		mode: input.mode,
		query: input.query,
		contextFile: input.contextFilePath,
		llmModel: input.llmModel,
		llmThinkingLevel: input.llmThinkingLevel,
		llmResponse: input.llmResponse,
		llmLatencyMs: input.llmLatencyMs,
		pinned: input.pinned,
		included: input.included,
		excluded: input.excluded,
		skillBlockTokens: estimateTokens(input.newBlock),
		originalBlockTokens: estimateTokens(input.originalBlock),
		toolIncluded: input.toolIncluded,
		toolExcluded: input.toolExcluded,
		toolBlockTokens: input.toolBlockTokens,
		originalToolBlockTokens: input.originalToolBlockTokens,
		keptAllDueToParseFailure: input.keptAllDueToParseFailure,
		cacheHit: input.cacheHit,
		prepassInputTokens: input.prepassUsage?.input,
		prepassOutputTokens: input.prepassUsage?.output,
		prepassCacheReadTokens: input.prepassUsage?.cacheRead,
		prepassCacheWriteTokens: input.prepassUsage?.cacheWrite,
		// Locally-computed prepass INPUT size (system prompt + user message). Always
		// available when a prepass ran, unlike the provider-reported usage above
		// (which github-copilot often omits). Doubles as the cohort signal: it drops
		// when the pruning prompt/descriptions are compacted.
		prepassInputEstimateTokens:
			input.prepassSystemPrompt || input.prepassUserMessage
				? estimateTokens(input.prepassSystemPrompt ?? "") + estimateTokens(input.prepassUserMessage ?? "")
				: undefined,
		codeVersion: input.codeVersion,
	};
}

/** Per-tool JSON framing overhead (name + description wrapper): ~50 chars ≈ 13 tokens. */
const TOOL_FRAMING_TOKENS = 13;

/**
 * Total tokens for the descriptions of the tools whose names appear in `names`
 * (kept, pruned, or all — the caller chooses the subset). Used both for "tokens
 * saved" reporting (the pruned subset) and for the skill-parallel block-token
 * accounting (the kept / all subsets). Counts name + description via the real
 * BPE tokenizer plus a small per-tool framing constant for the JSON wrapper.
 */
export function estimateToolTokens(allTools: ToolInfo[], names: string[]): number {
	const nameSet = new Set(names);
	let tokens = 0;
	for (const tool of allTools) {
		if (nameSet.has(tool.name)) {
			tokens += countTokens(tool.name) + countTokens(tool.description ?? "") + TOOL_FRAMING_TOKENS;
		}
	}
	return tokens;
}

/**
 * Compose the chat-message payload that surfaces pruning activity to
 * the user. Returns `null` when there's nothing to show. When the
 * prepass errored, the message surfaces the error verbatim.
 */
export function buildFeedbackMessage(
	skillResult: SkillPruningResult | null,
	toolResult: ToolPruningResult | null,
	mode: PruningConfig["mode"],
	prepass?: PrepassDiagnostics,
): PruningFeedbackMessage | null {
	if (prepass?.error) {
		const details: PruningResult = {
			includedSkills: skillResult?.included ?? [],
			excludedSkills: skillResult?.excluded ?? [],
			includedTools: toolResult?.included ?? [],
			excludedTools: toolResult?.excluded ?? [],
			mode,
			skillTokensSaved: 0,
			toolTokensSaved: 0,
			prepassModel: prepass.model,
			...(prepass.provider ? { prepassProvider: prepass.provider } : {}),
			prepassThinkingLevel: prepass.thinkingLevel,
			prepassError: prepass.error,
		};
		if (prepass.response) details.prepassResponse = prepass.response;
		if (prepass.thinking) details.prepassThinking = prepass.thinking;
		if (prepass.systemPrompt) details.prepassSystemPrompt = prepass.systemPrompt;
		if (prepass.userMessage) details.prepassUserMessage = prepass.userMessage;
		details.prepassLatencyMs = prepass.latencyMs;
		applyPrepassUsage(details, prepass.usage);
		// Surface the error verbatim — never swallow it. Transport errors
		// (5xx/429/network) are prefixed so users can tell an upstream blip
		// apart from a genuine content/parse failure. This is the only
		// user-visible signal that the prepass failed; truncating or
		// summarising it would hide the diagnostic needed to debug it.
		const isTransport = /\b(?:5\d\d|429)\b/.test(prepass.error)
			|| /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(prepass.error);
		const label = isTransport ? "Pruning prepass skipped (provider transport error, kept all skills)" : "Pruning error (kept all skills)";
		return {
			customType: "pruning-result",
			content: `${label}: ${prepass.error}`,
			display: true,
			details,
		};
	}

	if (!skillResult && !toolResult) {
		return null;
	}

	const details: PruningResult = {
		includedSkills: skillResult?.included ?? [],
		excludedSkills: skillResult?.excluded ?? [],
		includedTools: toolResult?.included ?? [],
		excludedTools: toolResult?.excluded ?? [],
		mode,
		skillTokensSaved: skillResult?.tokensSaved ?? 0,
		toolTokensSaved: toolResult?.tokensSaved ?? 0,
	};

	if (prepass) {
		details.prepassModel = prepass.model;
		if (prepass.provider) details.prepassProvider = prepass.provider;
		details.prepassThinkingLevel = prepass.thinkingLevel;
		if (prepass.response) details.prepassResponse = prepass.response;
		if (prepass.thinking) details.prepassThinking = prepass.thinking;
		if (prepass.systemPrompt) details.prepassSystemPrompt = prepass.systemPrompt;
		if (prepass.userMessage) details.prepassUserMessage = prepass.userMessage;
		details.prepassLatencyMs = prepass.latencyMs;
		applyPrepassUsage(details, prepass.usage);
		if (prepass.cacheHit) details.cacheHit = true;
		if (prepass.safeguardReason) details.prepassSafeguardReason = prepass.safeguardReason;
	}

	const hasSkillPruning = !!skillResult && skillResult.excluded.length > 0;
	const hasToolPruning = !!toolResult && toolResult.excluded.length > 0;

	const parts: string[] = [];
	if (hasSkillPruning) {
		parts.push(`Kept ${skillResult!.included.length}/${skillResult!.included.length + skillResult!.excluded.length} skills`);
	} else if (skillResult) {
		parts.push(`All ${skillResult.included.length} skills kept`);
	}
	if (hasToolPruning) {
		parts.push(`Kept ${toolResult!.included.length}/${toolResult!.included.length + toolResult!.excluded.length} tools`);
	} else if (toolResult) {
		parts.push(`All ${toolResult.included.length} tools kept`);
	}

	const tokensSaved = details.skillTokensSaved + details.toolTokensSaved;
	const tokenNote = tokensSaved > 0 ? ` · Saved ~${tokensSaved} tokens` : "";
	const latencyNote = formatLatencyNote(prepass?.latencyMs);
	const cacheNote = prepass?.cacheHit ? " · cached" : "";

	// Note: a keep-all outcome (nothing pruned) is the *expected* result of the
	// keep-biased prepass, not a warning. Frame it identically to the pruned
	// case — just the kept counts plus any notes — so it never reads as a
	// prepass failure. The latency note is the real signal for a slow prepass.
	const content = `${parts.join(", ")}${tokenNote}${latencyNote}${cacheNote}`;

	return {
		customType: "pruning-result",
		content,
		display: true,
		details,
	};
}
