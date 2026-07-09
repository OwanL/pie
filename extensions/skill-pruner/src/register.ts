import type { ExtensionAPI, BeforeAgentStartEvent, ToolCallEvent, Skill } from "@earendil-works/pi-coding-agent";
import { appendDecision, estimateTokens, recordSkillRead, recordKnownSkills, recordSkillsBlockNotFound } from "../logger.js";
import {
	setPiApi,
	getFormatSkillsForPromptImpl,
	getPiToolSeams,
	state,
} from "./state.js";
import { toErrorMessage } from "../../../shared/error-message.js";
import { recordKeptSkills } from "../../../shared/pruned-skills.js";
import { requestToolDefinition } from "./tools.js";
import { getCodeVersion } from "./version.js";
import { pruningResultRenderer } from "./render.js";
import {
	shouldSkipPruning,
	resolveVisibleSkills,
	applySkillSelection,
	applyToolSelection,
	getSessionId,
	getSessionPath,
	getCompleteFn,
	getConfig,
	getRecentConversation,
	SKILLS_BLOCK_RE,
	runPruningPrepass,
	SkillPruningResult,
	ToolPruningResult,
	PrepassUsage,
	buildHint,
	buildReplacement,
	buildDecision,
	buildFeedbackMessage,
	estimateToolTokens,
} from "./pruning.js";

export default function register(pi: ExtensionAPI) {
	// Capture pi API methods for tool introspection (available throughout the session).
	setPiApi({
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
	});

	// --- Message renderer for pruning-result custom type ---
	pi.registerMessageRenderer("pruning-result", (message: { content: string; details?: unknown }, { expanded }: { expanded: boolean }, theme: { bg: (key: string, child: unknown) => unknown; fg: (key: string, text: string) => string }) => {
		return pruningResultRenderer.render(message, { expanded }, theme);
	});

	// --- request_tool: recovery tool for pruned tools ---
	pi.registerTool(requestToolDefinition);

	// --- before_agent_start: skill + tool pruning ---
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: unknown) => {
		const activeConfig = getConfig();
		const skipInfo = shouldSkipPruning(event, activeConfig);
		// Resolved before the early-return block so the disabled-by-toggle path can
		// record keep-all for subagent inheritance (keyed by this session id).
		const sessionId = getSessionId(ctx);
		if (skipInfo.skip && (skipInfo.reason === "disabled-by-toggle" || skipInfo.reason === "subagent")) {
			// disabled-by-toggle: user turned the extension off via PIE_EXTENSION_TOGGLES_JSON.
			// subagent: running inside a scoped subagent session — the prepass is
			// main-agent-oriented and would add 20–35s (+ a failure mode) per turn.
			//
			// Record keep-all for the disabled path so subagents spawned this turn
			// inherit "no filtering" rather than a stale set from a previous turn.
			// The subagent path records nothing (subagent sessions are not main).
			if (skipInfo.reason === "disabled-by-toggle") {
				recordKeptSkills(sessionId, "keep-all");
			}
			return undefined;
		}

		const skills = event.systemPromptOptions.skills ?? [];
		const allSkillPaths = skills.map((s: Skill) => s.filePath);

		if (skipInfo.skip) {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			// off / too-short: the main session keeps every visible skill, so
			// subagents should inherit keep-all (no filter) for this turn.
			recordKeptSkills(sessionId, "keep-all");
			return undefined;
		}

		const sessionPath = getSessionPath(ctx);
		let modifiedSystemPrompt = event.systemPrompt;
		let skillPruningRan = false;
		let skillResult: SkillPruningResult | null = null;
		let toolResult: ToolPruningResult | null = null;
		let pruningError: string | null = null;
		let rawResponse = "";
		let rawThinking = "";
		let rawSystemPrompt = "";
		let rawUserMessage = "";
		let prepassThinkingLevel = activeConfig.thinkingLevel;
		let latencyMs = 0;
		let prepassUsage: PrepassUsage | undefined;
		let skillSafeguardReason: string | undefined;
		let toolSafeguardReason: string | undefined;
		let keptAllDueToParseFailure = false;

		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const hasToolsConfig = activeConfig.tools && allTools.length > 0;

		if (skills.length > 0 || hasToolsConfig) {
			const { visibleSkills, effectivePinned } = resolveVisibleSkills(skills, activeConfig);
			const contextFile = event.systemPromptOptions.contextFiles?.[0];

			// Always-keep (pinned / alwaysKeep) skills and tools are never
			// candidates for pruning. Exclude them from the prepass entirely so
			// the model never sees them and never spends tokens reasoning about
			// them — they are unconditionally re-added downstream by
			// applySkillSelection / applyToolSelection. Telling the model about
			// them only to re-protect them afterward is pure waste.
			const forcedSkillNames = new Set(effectivePinned);
			const forcedToolNames = new Set(activeConfig.tools?.alwaysKeep ?? []);

			const llmInput = {
				userPrompt: event.prompt,
				contextFile: contextFile?.path,
				skills: visibleSkills
					.filter((s) => !forcedSkillNames.has(s.name))
					.map((s) => ({ name: s.name, description: s.description })),
				tools: allTools
					.filter((t) => !forcedToolNames.has(t.name))
					.map((t) => ({ name: t.name, description: t.description ?? "" })),
				config: activeConfig,
				recentConversation: getRecentConversation(ctx),
			};

			let prunedSkills: string[] | null = null;
			let prunedTools: string[] | null = null;

			const completeFn = getCompleteFn(ctx);
			if (!completeFn) {
				pruningError = "No completion function available";
				recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			} else {
				const prepassResult = await runPruningPrepass(ctx, llmInput, activeConfig, completeFn);
				prunedSkills = prepassResult.prunedSkills;
				prunedTools = prepassResult.prunedTools;
				pruningError = prepassResult.error;
				rawResponse = prepassResult.rawResponse;
				rawThinking = prepassResult.rawThinking;
				rawSystemPrompt = prepassResult.rawSystemPrompt;
				rawUserMessage = prepassResult.rawUserMessage;
				prepassThinkingLevel = prepassResult.thinkingLevel;
				latencyMs = prepassResult.latencyMs;
				prepassUsage = prepassResult.usage;
				keptAllDueToParseFailure = prepassResult.keptAllDueToParseFailure ?? false;
			}

			if (!pruningError || pruningError.startsWith("Model") || pruningError.startsWith("LLM pruning failed")) {
				// Tool selection runs first so the skill keep-all safeguard can tell
				// whether any tools survive: a legitimate full skill-prune is allowed
				// through whenever tools remain (zero skills leaves the agent
				// functional, unlike zero tools).
				const toolSelection = applyToolSelection(allTools, prunedTools, activeConfig);
				toolSafeguardReason = toolSelection.safeguardReason ?? toolSafeguardReason;

				const toolsRemain = toolSelection.includedToolNames.length > 0;
				const skillSelection = applySkillSelection(visibleSkills, prunedSkills, effectivePinned, activeConfig, toolsRemain);
				skillSafeguardReason = skillSelection.safeguardReason ?? skillSafeguardReason;

				// --- Skill pruning: rewrite the skills block in the system prompt ---
				const match = event.systemPrompt.match(SKILLS_BLOCK_RE);
				let newSkillBlock = "";
				let originalSkillBlock = "";
				if (match) {
					const includedSkills = visibleSkills.filter((s) => skillSelection.includedSkillNames.includes(s.name));
					const replacement = buildReplacement(getFormatSkillsForPromptImpl()(includedSkills), buildHint(skillSelection.excludedSkillNames));
					newSkillBlock = replacement;
					originalSkillBlock = match[0];

					skillResult = {
						included: skillSelection.includedSkillNames,
						excluded: skillSelection.excludedSkillNames,
						tokensSaved: estimateTokens(originalSkillBlock) - estimateTokens(newSkillBlock),
					};

					const excludedSkillPaths = skillSelection.excludedSkillNames.map((name) => visibleSkills.find((skill) => skill.name === name)?.filePath).filter(Boolean) as string[];
					if (activeConfig.mode === "shadow") {
						recordKnownSkills(sessionId, "shadow", allSkillPaths, [], excludedSkillPaths);
					} else {
						recordKnownSkills(sessionId, "auto", allSkillPaths, excludedSkillPaths, []);
						modifiedSystemPrompt = event.systemPrompt.replace(SKILLS_BLOCK_RE, replacement);
						skillPruningRan = true;
					}
				} else if (skills.length > 0) {
					console.warn("[skill-pruner] skills block not found in system prompt; skipping skill pruning");
					recordSkillsBlockNotFound(sessionId, activeConfig.mode);
					recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
				}

				// --- Tool pruning: disable pruned tools (auto mode only) ---
				if (activeConfig.tools && allTools.length > 0) {
					if (activeConfig.mode === "auto" && toolSelection.excludedToolNames.length > 0) {
						if (state.setActiveToolsOverride) {
							state.setActiveToolsOverride(toolSelection.includedToolNames);
						} else {
							getPiToolSeams().setActiveTools(toolSelection.includedToolNames);
						}
					}
					toolResult = {
						included: toolSelection.includedToolNames,
						excluded: toolSelection.excludedToolNames,
						tokensSaved: estimateToolTokens(allTools, toolSelection.excludedToolNames),
					};
				}

				// --- Audit decision: one row covering skills + tools so analytics sees both ---
				// (Previously only skill data was logged, so tool pruning was invisible to the
				// dashboard. Tool token estimates mirror the skill-block accounting.)
				const skillsBlockFound = !!match;
				const toolsConsidered = !!(activeConfig.tools && allTools.length > 0);
				if (skillsBlockFound || toolsConsidered) {
					appendDecision(buildDecision({
						sessionId, sessionPath, mode: activeConfig.mode, query: event.prompt,
						contextFilePath: contextFile?.path, llmModel: activeConfig.model,
						llmThinkingLevel: prepassThinkingLevel, llmResponse: rawResponse, llmLatencyMs: latencyMs,
						// Skill pruning is only actually applied when the skills block was found;
						// otherwise report keep-all so the analytics row matches recordKnownSkills.
						included: skillsBlockFound ? skillSelection.includedSkillNames : visibleSkills.map((s) => s.name),
						excluded: skillsBlockFound ? skillSelection.excludedSkillNames : [],
						pinned: effectivePinned, newBlock: newSkillBlock, originalBlock: originalSkillBlock,
						toolIncluded: toolsConsidered ? toolSelection.includedToolNames : undefined,
						toolExcluded: toolsConsidered ? toolSelection.excludedToolNames : undefined,
						toolBlockTokens: toolsConsidered ? estimateToolTokens(allTools, toolSelection.includedToolNames) : undefined,
						originalToolBlockTokens: toolsConsidered ? estimateToolTokens(allTools, allTools.map((t) => t.name)) : undefined,
						keptAllDueToParseFailure,
						prepassUsage,
						prepassSystemPrompt: rawSystemPrompt,
						prepassUserMessage: rawUserMessage,
						codeVersion: getCodeVersion(),
					}));
				}
			}
		} else {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
		}

		const parseFailureNote = keptAllDueToParseFailure
			? "prepass response was non-JSON prose — kept all (parse failure)"
			: undefined;
		const safeguardReason = [skillSafeguardReason, toolSafeguardReason, parseFailureNote]
			.filter((r): r is string => Boolean(r))
			.join(" · ") || undefined;

		const feedbackMessage = buildFeedbackMessage(skillResult, toolResult, activeConfig.mode, {
			model: activeConfig.model,
			thinkingLevel: prepassThinkingLevel,
			response: rawResponse,
			thinking: rawThinking,
			systemPrompt: rawSystemPrompt,
			userMessage: rawUserMessage,
			latencyMs,
			usage: prepassUsage,
			error: pruningError,
			safeguardReason,
		});

		// Record the kept-skill set for subagent inheritance (direction C). This is
		// the single recording point for every non-early-return path: success,
		// shadow, parse-failure safeguard, block-not-found, no-completeFn, and
		// error all reach here. `skillResult.included` holds the kept subset when
		// the prepass ran and the skills block was found; otherwise null → keep-all
		// (no filtering) so subagents never read a stale set from a previous turn.
		recordKeptSkills(sessionId, skillResult?.included ?? "keep-all");

		if (activeConfig.mode === "shadow") {
			return { systemPrompt: event.systemPrompt, message: feedbackMessage ?? undefined };
		}
		if (skillPruningRan) {
			return { systemPrompt: modifiedSystemPrompt, message: feedbackMessage ?? undefined };
		}
		return feedbackMessage ? { message: feedbackMessage } : undefined;
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: unknown) => {
		try {
			if (event.toolName !== "read") {
				return undefined;
			}

			const readPath = typeof event.input?.path === "string" ? event.input.path : undefined;
			if (readPath !== undefined) {
				recordSkillRead(getSessionId(ctx), readPath);
			}
		} catch (error) {
			console.warn(`[skill-pruner] failed to record skill read: ${toErrorMessage(error)}`);
		}
		return undefined;
	});
}
