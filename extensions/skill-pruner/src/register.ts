import type { ExtensionAPI, BeforeAgentStartEvent, InputEvent, ToolCallEvent, Skill } from "@earendil-works/pi-coding-agent";
import { appendDecision, estimateTokens, recordSkillRead, recordKnownSkills, recordSkillsBlockNotFound } from "../logger.js";
import {
	setPiApi,
	getFormatSkillsForPromptImpl,
	getPiToolSeams,
	getPrunedTools,
	recordHiddenSkills,
	recordPrunedTools,
	state,
} from "./state.js";
import { toErrorMessage } from "../../../shared/error-message.js";
import { recordKeptSkills } from "../../../shared/pruned-skills.js";
import { requestCapabilityDefinition } from "./tools.js";
import { getCodeVersion, prewarmCodeVersion } from "./version.js";
import { buildPruningSystemPrompt, buildPruningUserMessage } from "../llm-scorer.js";
import {
	buildPrepassFingerprint,
	cacheSuccessfulPrepass,
	cacheSuccessfulPrepassCrossSession,
	getCachedPrepass,
	getCachedPrepassCrossSession,
} from "./prepass-cache.js";
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
	RECOVERY_TOOL_NAME,
} from "./pruning.js";

export default function register(pi: ExtensionAPI) {
	// Asynchronously pre-warm the cached code version (git SHA) so the first
	// `before_agent_start` doesn't pay the subprocess latency on the
	// latency-critical prepass path. Fire-and-forget: no long-lived resource is
	// started (a single bounded `exec`), and registration is not blocked.
	prewarmCodeVersion();

	// Capture pi API methods for tool introspection (available throughout the session).
	setPiApi({
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
	});

	// Keep pruning telemetry as a custom message so the host can track prepass
	// completion and usage, but remove it from every provider request below.
	pi.registerMessageRenderer("pruning-result", (message: { content: string; details?: unknown }, { expanded }: { expanded: boolean }, theme: { bg: (key: string, child: unknown) => unknown; fg: (key: string, text: string) => string }) => {
		return pruningResultRenderer.render(message, { expanded }, theme);
	});

	pi.on("context", (event: { messages: Array<{ role?: string; customType?: string }> }) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== "pruning-result"),
	}));

	// One minimal recovery surface for both hidden tools and hidden skills.
	pi.registerTool(requestCapabilityDefinition);

	// Inputs submitted while an agent is running are steering/continuation
	// messages, not independent task pivots. Remember them so their eventual
	// before_agent_start hook can preserve the current catalog without paying for
	// another pruning prepass (or inserting a pruning-result transcript entry).
	const queuedPrompts = new Map<string, number>();
	pi.on("input", (event: InputEvent) => {
		if (event.streamingBehavior) {
			queuedPrompts.set(event.text, (queuedPrompts.get(event.text) ?? 0) + 1);
		}
		return { action: "continue" };
	});

	// --- before_agent_start: skill + tool pruning ---
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: unknown) => {
		const queuedCount = queuedPrompts.get(event.prompt) ?? 0;
		if (queuedCount > 0) {
			if (queuedCount === 1) queuedPrompts.delete(event.prompt);
			else queuedPrompts.set(event.prompt, queuedCount - 1);
			return undefined;
		}

		const activeConfig = getConfig();
		const skipInfo = shouldSkipPruning(event, activeConfig);
		const sessionId = getSessionId(ctx);
		// A new top-level pruning decision owns a fresh hidden-skill catalog.
		// Queued continuations returned above intentionally retain the current one.
		recordHiddenSkills(sessionId, []);
		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const restorePrunerOwnedTools = () => {
			const previouslyPruned = getPrunedTools(sessionId);
			if (previouslyPruned.size === 0) return;
			const activeNames = state.getActiveToolsOverride
				? state.getActiveToolsOverride()
				: getPiToolSeams().getActiveTools();
			const restored = [...new Set([...activeNames, ...previouslyPruned])];
			if (state.setActiveToolsOverride) state.setActiveToolsOverride(restored);
			else getPiToolSeams().setActiveTools(restored);
			recordPrunedTools(sessionId, []);
		};

		if (skipInfo.skip && (skipInfo.reason === "disabled-by-toggle" || skipInfo.reason === "subagent")) {
			// Subagent sessions own their scoped tool set, so never mutate it. When
			// the main-session extension is disabled, restore tools left inactive by
			// a prior auto-mode turn before returning.
			if (skipInfo.reason === "disabled-by-toggle") {
				restorePrunerOwnedTools();
				recordKeptSkills(sessionId, "keep-all");
			}
			return undefined;
		}

		const skills = event.systemPromptOptions.skills ?? [];
		const allSkillPaths = skills.map((s: Skill) => s.filePath);

		if (skipInfo.skip) {
			restorePrunerOwnedTools();
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			// off / too-short: the main session keeps every visible skill, so
			// subagents should inherit keep-all (no filter) for this turn.
			recordKeptSkills(sessionId, "keep-all");
			return undefined;
		}

		// Shadow mode observes decisions but must undo any tool filtering left by
		// a preceding auto-mode turn.
		if (activeConfig.mode === "shadow") restorePrunerOwnedTools();

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
		let cacheHit = false;

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
			// The recovery tool itself is never a prune candidate. Tools recovered
			// under the previous decision are not protected here: this new decision
			// may hide them again when the task changes.
			const forcedToolNames = new Set<string>([...(activeConfig.tools?.alwaysKeep ?? []), RECOVERY_TOOL_NAME]);

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

			// autoSkipBelowTokens is based only on the assembled prepass input, not
			// the main agent's much larger system prompt. This is a neutral keep-all
			// optimization, not an error or pruning-result event.
			const estimatedPrepassTokens = estimateTokens(buildPruningSystemPrompt(activeConfig))
				+ estimateTokens(buildPruningUserMessage(llmInput));
			if (activeConfig.autoSkipBelowTokens != null && estimatedPrepassTokens < activeConfig.autoSkipBelowTokens) {
				// A prior auto-mode turn may have disabled tools. Fail-open means
				// restoring the complete catalog, not merely skipping this decision.
				if (activeConfig.mode === "auto") restorePrunerOwnedTools();
				recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
				recordKeptSkills(sessionId, "keep-all");
				return undefined;
			}

			const fingerprint = buildPrepassFingerprint(llmInput, activeConfig);
			const continuationFingerprint = buildPrepassFingerprint(llmInput, activeConfig, false);
			let cached = getCachedPrepass(sessionId, event.prompt, fingerprint, continuationFingerprint);
			if (!cached) {
				const crossSession = getCachedPrepassCrossSession(event.prompt, fingerprint);
				if (crossSession) {
					// Promote the cross-session exact hit to this session's per-session
					// cache so subsequent continuation prompts ("continue") reuse it —
					// preserving per-session continuation semantics. The cross-session
					// hit was an EXACT match (prompt + fingerprint including recent
					// conversation), so promoting it within the session is safe.
					cacheSuccessfulPrepass(sessionId, event.prompt, fingerprint, continuationFingerprint, crossSession);
					cached = crossSession;
				}
			}
			const completeFn = getCompleteFn(ctx);
			if (!cached && !completeFn) {
				pruningError = "No completion function available";
				recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			} else {
				const prepassResult = cached ?? await runPruningPrepass(ctx, llmInput, activeConfig, completeFn!);
				if (!cached) {
					cacheSuccessfulPrepass(sessionId, event.prompt, fingerprint, continuationFingerprint, prepassResult);
					cacheSuccessfulPrepassCrossSession(event.prompt, fingerprint, prepassResult);
				}
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
				cacheHit = prepassResult.cacheHit ?? false;
			}

			// Every failure is fail-open for tools, including auth/no-completion
			// failures that do not enter the normal selection/rendering path below.
			if (pruningError && activeConfig.mode === "auto") restorePrunerOwnedTools();

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
					const excludedSkills = visibleSkills.filter((s) => skillSelection.excludedSkillNames.includes(s.name));
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
						recordHiddenSkills(sessionId, excludedSkills);
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
					// Always apply the resolved auto-mode set, including keep-all and
					// fail-open outcomes, so tools pruned on a previous turn are restored.
					if (activeConfig.mode === "auto") {
						const hadPrunedTools = getPrunedTools(sessionId).size > 0;
						if (toolSelection.excludedToolNames.length > 0 || hadPrunedTools) {
							if (state.setActiveToolsOverride) {
								state.setActiveToolsOverride(toolSelection.includedToolNames);
							} else {
								getPiToolSeams().setActiveTools(toolSelection.includedToolNames);
							}
						}
						recordPrunedTools(sessionId, toolSelection.excludedToolNames);
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
						cacheHit,
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
			cacheHit,
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
