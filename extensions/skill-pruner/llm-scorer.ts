import { readFileSync } from "node:fs";
import path from "node:path";
import type { PruningConfig } from "./types.js";
import { parseJsonOrThrow } from "../../shared/error-message.js";

export interface SkillCandidate {
	name: string;
	description: string;
}

export interface ToolCandidate {
	name: string;
	description: string;
}

export interface RecentConversationMessage {
	role: string;
	text: string;
}

export interface LlmPruningInput {
	userPrompt: string;
	contextFile?: string;
	recentConversation?: RecentConversationMessage[];
	skills: SkillCandidate[];
	tools: ToolCandidate[];
	config: PruningConfig;
}

export interface LlmPruningOutput {
	prunedSkills: string[];
	prunedTools: string[];
	rawResponse: string;
	rawThinking: string;
	systemPrompt: string;
	userMessage: string;
	latencyMs: number;
	stopReason?: string;
	errorMessage?: string;
	usage?: PrepassUsage;
	/** True when the prepass response was unreadable as JSON → kept all (parse failure). */
	keptAllDueToParseFailure?: boolean;
}

export interface PrepassUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CompleteSimpleResult {
	text: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Partial<PrepassUsage>;
}

const DEFAULT_PROMPT_TEMPLATE = loadPromptTemplate();
let promptTemplateOverride: string | null = null;

function loadPromptTemplate(): string {
	try {
		return readFileSync(path.join(import.meta.dirname, "pruning-system-prompt.md"), "utf-8").trim();
	} catch {
		return [
			"You are a relevance curator for a coding agent's prompt-pruning prepass.",
			"Your job is to decide which skills and tools can be safely REMOVED from the agent's context this turn.",
			"Default to KEEPING. Only remove an item when you are confident it is irrelevant to the entire arc of the work.",
			"",
			"Respond with ONLY a valid JSON object in this exact shape:",
			'{"reasoning":"1-2 short sentences","pruneSkills":["skill-name"],"pruneTools":["tool-name"]}',
			"List only items to REMOVE. Empty or omitted lists keep everything. Do not wrap in markdown.",
			"",
			"{{STRATEGY_INSTRUCTION}}",
		].join("\n");
	}
}

function resolvePromptTemplate(): string {
	return promptTemplateOverride ?? DEFAULT_PROMPT_TEMPLATE;
}

function buildStrategyInstruction(config: PruningConfig): string {
	if (config.skills.strategy === "topK") {
		return `The agent's context is most effective with at most ${config.skills.ceiling} skills and ${config.tools?.ceiling ?? 10} tools. Prefer keeping the most relevant; if you judge more than that as relevant, remove the least relevant to approach the ceiling. Still never remove something the arc of the work plausibly needs.`;
	}
	return "Use discretion: remove only items you are confident are irrelevant to the entire arc of the work. You are not expected to remove anything — an empty result is correct when nothing is clearly irrelevant.";
}

/** Build the system prompt for the pruning LLM call. */
export function buildPruningSystemPrompt(config: PruningConfig): string {
	return resolvePromptTemplate()
		.replace(/\{\{SKILL_CEILING\}\}/g, String(config.skills.ceiling))
		.replace(/\{\{TOOL_CEILING\}\}/g, String(config.tools?.ceiling ?? 10))
		.replace(/\{\{STRATEGY_INSTRUCTION\}\}/g, buildStrategyInstruction(config));
}

/** Build the user message for the pruning LLM call. */
export function buildPruningUserMessage(input: LlmPruningInput): string {
	const lines = [`User request: "${input.userPrompt}"`];

	if (input.recentConversation && input.recentConversation.length > 0) {
		lines.push("", "Recent conversation (use this to interpret follow-up requests):");
		for (const message of input.recentConversation) {
			lines.push(`- ${message.role}: ${message.text}`);
		}
	}

	if (input.contextFile) {
		lines.push("", `Context file: ${input.contextFile}`);
	}

	lines.push("", "Available skills (list any to REMOVE):");
	for (const s of input.skills) {
		lines.push(`- ${s.name}: ${s.description}`);
	}

	lines.push("", "Available tools (list any to REMOVE):");
	for (const t of input.tools) {
		lines.push(`- ${t.name}: ${t.description}`);
	}

	return lines.join("\n");
}

export interface ParsedLlmResponse {
	pruneSkills: string[];
	pruneTools: string[];
	reasoning?: string;
	/**
	 * True ONLY when parsing genuinely failed (the phase-3 fallback): the
	 * response could not be read as JSON or an embedded JSON block, so we
	 * resolved to keep-all rather than risk misparsing prose. Deliberately
	 * NOT set when phases 1/2 succeed with legitimately empty prune lists —
	 * that is an intentional keep-all, not a failure. This flag is the only
	 * way analytics can tell parse-failure keep-all apart from intentional
	 * keep-all (both produce empty prune lists).
	 */
	keptAllDueToParseFailure?: boolean;
}

/** Sentinel for "keep everything" — returned whenever the response can't be confidently read as a prune list. */
const EMPTY_PRUNE: ParsedLlmResponse = { pruneSkills: [], pruneTools: [], keptAllDueToParseFailure: true };

/**
 * Convert an already-parsed object into a `ParsedLlmResponse`, filtering
 * the prune lists against the known name sets. Returns `null` if the input
 * is not a plain object, allowing the caller to fall through.
 */
function buildParsedResponse(
	parsed: unknown,
	knownSkills: Set<string>,
	knownTools: Set<string>,
): ParsedLlmResponse | null {
	if (!parsed || typeof parsed !== "object") return null;
	const rawSkills = Array.isArray((parsed as { pruneSkills?: unknown }).pruneSkills)
		? (parsed as { pruneSkills: unknown[] }).pruneSkills
		: undefined;
	const rawTools = Array.isArray((parsed as { pruneTools?: unknown }).pruneTools)
		? (parsed as { pruneTools: unknown[] }).pruneTools
		: undefined;
	const pruneSkills = rawSkills
		? rawSkills.filter((s): s is string => typeof s === "string" && knownSkills.has(s))
		: [];
	const pruneTools = rawTools
		? rawTools.filter((t): t is string => typeof t === "string" && knownTools.has(t))
		: [];
	const reasoningRaw = (parsed as { reasoning?: unknown }).reasoning;
	const result: ParsedLlmResponse = { pruneSkills, pruneTools };
	if (typeof reasoningRaw === "string" && reasoningRaw.length > 0) result.reasoning = reasoningRaw;
	return result;
}

/** Try to JSON.parse `candidate` and convert the result. Returns `null` on any failure. */
function tryParseJson(candidate: string, knownSkills: Set<string>, knownTools: Set<string>): ParsedLlmResponse | null {
	try {
		return buildParsedResponse(parseJsonOrThrow(candidate, "LLM pruning response"), knownSkills, knownTools);
	} catch {
		return null;
	}
}

/**
 * Parse the LLM response as a prune list. Any failure to read a valid
 * prune list resolves to "keep everything" (empty prune lists) — the safe,
 * hesitant default. We deliberately do NOT scrape known names out of prose,
 * because prose usually names items to KEEP, which would invert intent.
 */
export function parseLlmResponse(raw: string, knownSkills: Set<string>, knownTools: Set<string>): ParsedLlmResponse {
	// Phase 1: strict JSON parse of the whole response.
	const strict = tryParseJson(raw, knownSkills, knownTools);
	if (strict) return strict;

	// Phase 2: pull the first {...} block out of the response and try again.
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		const extracted = tryParseJson(jsonMatch[0], knownSkills, knownTools);
		if (extracted) return extracted;
	}

	// Phase 3: unreadable response — keep everything rather than risk misparsing.
	return EMPTY_PRUNE;
}

export type CompleteSimpleFn = (
	model: unknown,
	context: Array<{ role: string; content: string }>,
	options: Record<string, unknown>,
) => Promise<CompleteSimpleResult>;

/**
 * Run the LLM pruning call. Accepts a `completeFn` parameter for testability.
 */
export async function runLlmPruning(
	input: LlmPruningInput,
	model: unknown,
	options: Record<string, unknown>,
	completeFn: CompleteSimpleFn,
): Promise<LlmPruningOutput> {
	const systemPrompt = buildPruningSystemPrompt(input.config);
	const userMessage = buildPruningUserMessage(input);

	const context = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const start = Date.now();
	const response = await completeFn(model, context, options);
	const latencyMs = Date.now() - start;

	const knownSkills = new Set(input.skills.map((s) => s.name));
	const knownTools = new Set(input.tools.map((t) => t.name));
	const parsed = parseLlmResponse(response.text, knownSkills, knownTools);

	return {
		prunedSkills: parsed.pruneSkills,
		prunedTools: parsed.pruneTools,
		rawResponse: response.text,
		rawThinking: response.thinking ?? parsed.reasoning ?? "",
		systemPrompt,
		userMessage,
		latencyMs,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage ? {
			input: response.usage.input ?? 0,
			output: response.usage.output ?? 0,
			cacheRead: response.usage.cacheRead ?? 0,
			cacheWrite: response.usage.cacheWrite ?? 0,
		} : undefined,
		keptAllDueToParseFailure: parsed.keptAllDueToParseFailure,
	};
}

/** internal: test seam — overrides the prompt template. */
export function __setPromptTemplate(template: string | null): void {
	promptTemplateOverride = template;
}
