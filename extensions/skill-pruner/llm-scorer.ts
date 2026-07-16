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
			"Keep a candidate when it is more likely than not to be used across the full arc of the work.",
			"Return ONLY a valid JSON object in this exact shape:",
			'{"keep":[]}',
			"List only supplied candidate names. Do not include an explanation or reasoning. Do not wrap in markdown.",
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
		return `The preferred context size is at most ${config.skills.ceiling} skills and ${config.tools?.ceiling ?? 10} tools. Use that only as a tie-breaker for borderline candidates; never omit a candidate whose probability of use is greater than 50 percent.`;
	}
	return "Use the greater-than-50-percent probability boundary independently for every candidate. An empty keep list is correct when none is probably needed.";
}

/** Build the system prompt for the pruning LLM call. */
export function buildPruningSystemPrompt(config: PruningConfig): string {
	return resolvePromptTemplate()
		.replace(/\{\{SKILL_CEILING\}\}/g, String(config.skills.ceiling))
		.replace(/\{\{TOOL_CEILING\}\}/g, String(config.tools?.ceiling ?? 10))
		.replace(/\{\{STRATEGY_INSTRUCTION\}\}/g, buildStrategyInstruction(config));
}

/**
 * Char cap for a single candidate description in the prepass prompt. A
 * relevance decision only needs the *gist* of what a skill/tool does — not its
 * full usage guidance, truncation notes, or examples. Tool descriptions in
 * particular run to hundreds of words (e.g. `subagent` enumerates every agent,
 * bucket, and thinking level); keeping only the leading summary sentence(s)
 * strips the bulk of the prepass input tokens with no loss of signal.
 *
 * Tools and skills get different treatment. A tool's later sentences are usage
 * caveats (output-truncation notes, examples) that don't change relevance, so
 * tools are cut aggressively at the first sentence boundary. A *skill's* later
 * sentences frequently carry its "Use when …" TRIGGER — the actual relevance
 * signal — so skills keep a more generous cap and are never cut mid-list at an
 * early sentence break; they only get whitespace collapsed and truly verbose
 * outliers trimmed at a word boundary.
 */
const TOOL_DESCRIPTION_CHAR_CAP = 180;
const SKILL_DESCRIPTION_CHAR_CAP = 320;

/**
 * Reduce a skill/tool description to a compact relevance summary. Whitespace is
 * always collapsed to single spaces (multi-paragraph tool docs become one
 * line). When `sentenceAware` (tools), anything past a clean sentence boundary
 * within the cap is dropped; otherwise (skills) the text is only hard-capped at
 * a word boundary. Short descriptions pass through unchanged.
 */
export function compactDescription(
	description: string,
	maxChars = TOOL_DESCRIPTION_CHAR_CAP,
	sentenceAware = true,
): string {
	const normalized = (description ?? "").replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	const capped = normalized.slice(0, maxChars);
	// Tools: prefer ending on a sentence boundary within the cap, but not so
	// early that we lose the gist (>= 60 chars keeps the leading summary).
	if (sentenceAware) {
		const lastSentence = capped.lastIndexOf(". ");
		if (lastSentence >= 60) return capped.slice(0, lastSentence + 1);
	}
	const lastSpace = capped.lastIndexOf(" ");
	return `${capped.slice(0, lastSpace > 0 ? lastSpace : maxChars).trimEnd()}…`;
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

	lines.push("", "Candidate skills:");
	for (const s of input.skills) {
		// Skills: generous cap, no early sentence cut — preserve "Use when …" triggers.
		lines.push(`- ${s.name}: ${compactDescription(s.description, SKILL_DESCRIPTION_CHAR_CAP, false)}`);
	}

	lines.push("", "Candidate tools:");
	for (const t of input.tools) {
		lines.push(`- ${t.name}: ${compactDescription(t.description)}`);
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
	 * NOT set when phases 1/2 succeed with a valid response. This flag is the
	 * only way analytics can tell parse-failure keep-all apart from an
	 * intentional result that happens to keep everything.
	 */
	keptAllDueToParseFailure?: boolean;
}

/** Sentinel for "keep everything" — returned whenever the response contract is unreadable. */
const EMPTY_PRUNE: ParsedLlmResponse = { pruneSkills: [], pruneTools: [], keptAllDueToParseFailure: true };

/**
 * Convert an already-parsed response into internal prune lists. The current
 * flat keep-list contract is complemented against the known candidates; the
 * former typed prune-list contract remains readable for backward compatibility.
 * Returns `null` when the response shape is unreadable.
 */
function buildParsedResponse(
	parsed: unknown,
	knownSkills: Set<string>,
	knownTools: Set<string>,
): ParsedLlmResponse | null {
	if (!parsed || typeof parsed !== "object") return null;
	const keepRaw = (parsed as { keep?: unknown }).keep;
	if (keepRaw !== undefined) {
		if (!Array.isArray(keepRaw)) return null;
		const knownNames = new Set([...knownSkills, ...knownTools]);
		// A malformed/unknown positive name is unsafe to ignore: because omission
		// means prune, silently dropping a misspelling could remove the capability
		// the model meant to keep. Treat the whole response as unreadable so the
		// correction retry (and ultimately fail-open keep-all) owns the ambiguity.
		if (keepRaw.some((name) => typeof name !== "string" || !knownNames.has(name))) return null;
		const kept = new Set(keepRaw as string[]);
		return {
			pruneSkills: [...knownSkills].filter((name) => !kept.has(name)),
			pruneTools: [...knownTools].filter((name) => !kept.has(name)),
		};
	}
	// Backward-compatible read path for cached decisions, tests, and responses
	// produced by older prompt versions. New calls request the flat `keep` shape.
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

/** Remove trailing JSON commas without touching comma-like text inside strings. */
function removeTrailingJsonCommas(candidate: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < candidate.length; index++) {
		const char = candidate[index];
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < candidate.length && /\s/.test(candidate[next])) next++;
			if (candidate[next] === "]" || candidate[next] === "}") continue;
		}
		result += char;
	}
	return result;
}

/**
 * Parse the LLM response into internal prune lists. Any unreadable response
 * resolves to "keep everything" (empty prune lists), the safe fail-open
 * default. We deliberately do NOT scrape names out of prose because their
 * keep/prune intent would be ambiguous.
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

		// A common small-model failure is otherwise-valid JSON with trailing
		// commas. This repair is deliberately narrow: unlike scraping prose or
		// rewriting quotes, removing commas immediately before `]` / `}` cannot
		// invert the model's keep/prune intent.
		const withoutTrailingCommas = removeTrailingJsonCommas(jsonMatch[0]);
		if (withoutTrailingCommas !== jsonMatch[0]) {
			const repaired = tryParseJson(withoutTrailingCommas, knownSkills, knownTools);
			if (repaired) return repaired;
		}
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
	invalidResponseToCorrect?: string,
): Promise<LlmPruningOutput> {
	const systemPrompt = buildPruningSystemPrompt(input.config);
	const userMessage = buildPruningUserMessage(input);

	const context = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];
	if (invalidResponseToCorrect !== undefined) {
		context.push(
			{ role: "assistant", content: invalidResponseToCorrect.slice(0, 2_000) },
			{
				role: "user",
				content: 'That response was not valid JSON. Try again and return ONLY {"keep":[]} with the candidate names that are more likely than not to be used.',
			},
		);
	}

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
