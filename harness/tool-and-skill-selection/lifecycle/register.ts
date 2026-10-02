import type { ExtensionAPI, BeforeAgentStartEvent, InputEvent, ToolCallEvent, Skill } from "@earendil-works/pi-coding-agent";
import { appendDecision, estimateTokens, recordSkillRead, recordKnownSkills, recordSkillsBlockNotFound } from "./logger.js";
import {
	getFormatSkillsForPromptImpl,
	getAllowedChildTools,
	getHiddenSkills,
	getPrunedTools,
	recordAllowedChildTools,
	recordHiddenSkills,
	recordPrunedTools,
	state,
	PROCESS_SESSION_ID,
} from "../state/selector-state.js";
import { toErrorMessage } from "../../../lib/structured-logging/error-message.js";
import { rootSessionAttribution } from "../../../lib/session-attribution.js";
import { getPieBaseSystemPrompt, rebasePieToolPrompt } from "../../agent-instructions/prompt-assembly/pie-harness-prompt.js";
import { createRequestCapabilityDefinition, type PiToolSeams } from "../recovery/request-capability-ports.js";
import { getCodeVersion, prewarmCodeVersion } from "./version.js";
import type { PruningResult } from "../settings/config-types.js";
import {
	buildPrepassFingerprint,
	cacheSuccessfulPrepass,
	cacheSuccessfulPrepassCrossSession,
	getCachedPrepass,
	getCachedPrepassCrossSession,
} from "../state/prepass-cache.js";
import { pruningResultRenderer } from "./render.js";
import type { PrepassInvocation, PrepassRunResult, PrepassUsage, SkillPruningResult, ToolPruningResult } from "../prepass/types.js";
import { getCompleteFn, getRecentConversation, runPruningPrepass } from "../prepass/prepass.js";
import { buildReplacement, buildDecision, buildFeedbackMessage, estimateToolTokens } from "../prepass/message-builders.js";
import { shouldSkipPruning, getSessionId, getSessionPath, getConfig } from "./pruning-lifecycle.js";
import { resolveVisibleSkills, applySkillSelection, SKILLS_BLOCK_RE } from "../../agent-instructions/skill-selection/skill-policy.js";
import { applyToolSelection, RECOVERY_TOOL_NAME } from "../../tools/selection/tool-policy.js";
import { ASK_USER_TOOL_NAME } from "../../tools/catalog/tool-names.js";
import { isAutonomousModeEnabled } from "../settings/autonomous-mode.js";
import { isInSubagentContext, subagentContext } from "../../agent-processes/lib/process-lifecycle/subagent-context.js";
import {
	currentChildToolRuntimeOwner,
	registerChildToolRuntimeCleanup,
} from "../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js";
import { clearSessionPruningState } from "../state/session-pruning-state.js";

const DEFERRED_TRIGGER_WAKE_PREFIX = "[deferred trigger fired: ";
const WAKE_TOOL_NAMES = ["defer_trigger"];

export default function register(pi: ExtensionAPI) {
	// Asynchronously pre-warm the cached code version (git SHA) so the first
	// `before_agent_start` doesn't pay the subprocess latency on the
	// latency-critical prepass path. Fire-and-forget: no long-lived resource is
	// started (a single bounded `exec`), and registration is not blocked.
	prewarmCodeVersion();

	// Keep tool ownership local to this extension registration. Extension modules
	// are cached across main and in-process subagent sessions, so process-global
	// pi closures can be overwritten by a child and become stale when it is
	// disposed. Test overrides remain late-bound, but production calls always use
	// the pi instance that owns this registration's handlers and tools.
	const toolSeams: PiToolSeams = {
		getAllTools: () => state.getAllToolsOverride ? state.getAllToolsOverride() : pi.getAllTools(),
		getActiveTools: () => state.getActiveToolsOverride ? state.getActiveToolsOverride() : pi.getActiveTools(),
		setActiveTools: (names) => {
			if (state.setActiveToolsOverride) state.setActiveToolsOverride(names);
			else pi.setActiveTools(names);
		},
	};

	// Keep pruning telemetry as a custom message so the host can track prepass
	// completion and usage, but remove it from every provider request below.
	// The generic pins T to PruningResult so `message.details` is the real
	// payload type and the renderer/context seam keeps Pi's public shapes.
	pi.registerMessageRenderer<PruningResult>("pruning-result", (message, options, theme) =>
		pruningResultRenderer.render(message, options, theme));

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== "pruning-result"),
	}));

	// One minimal recovery surface for both hidden tools and hidden skills.
	pi.registerTool(createRequestCapabilityDefinition(toolSeams));

	// Inputs submitted while an agent is running are steering/continuation
	// messages, not independent task pivots. Remember them so their eventual
	// before_agent_start hook can preserve the current catalog without paying for
	// another pruning prepass (or inserting a pruning-result transcript entry).
	const queuedPrompts = new Map<string, number>();
	// One launch-time decision per child session owned by this extension
	// registration. Mark before awaiting the scorer so failures and concurrent
	// continuations never trigger an unnecessary second prepass.
	const processedChildSessions = new Set<string>();
	pi.on("input", (event: InputEvent) => {
		if (event.streamingBehavior) {
			queuedPrompts.set(event.text, (queuedPrompts.get(event.text) ?? 0) + 1);
		}
		return { action: "continue" };
	});

	// --- before_agent_start: skill + tool pruning ---
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: unknown) => {
		const sessionId = getSessionId(ctx);
		const isChildSession = isInSubagentContext();
		const childRuntimeOwner = isChildSession && sessionId !== PROCESS_SESSION_ID
			? currentChildToolRuntimeOwner()
			: undefined;
		if (isChildSession && sessionId !== PROCESS_SESSION_ID) {
			if (childRuntimeOwner?.state === "open") {
				registerChildToolRuntimeCleanup(childRuntimeOwner, `skill-pruner-state:${sessionId}`, () => {
					clearSessionPruningState(sessionId);
					processedChildSessions.delete(sessionId);
				});
			} else if (childRuntimeOwner) {
				// Teardown can race a final extension callback. Do not repopulate
				// session state after the owner has started disposing its resources.
				clearSessionPruningState(sessionId);
				processedChildSessions.delete(sessionId);
				return undefined;
			}
		}
		const stopIfChildRuntimeDisposed = (): boolean => {
			if (!childRuntimeOwner || childRuntimeOwner.state === "open") return false;
			// The owner may begin teardown while the scorer is pending. Cleanup can
			// still be in flight when this continuation resumes, so fence and clear
			// here as well as relying on the registered owner cleanup.
			clearSessionPruningState(sessionId);
			processedChildSessions.delete(sessionId);
			return true;
		};
		let modifiedSystemPrompt = event.systemPrompt;
		let currentPieBasePrompt = getPieBaseSystemPrompt(ctx);
		let toolPromptRefreshFailed = false;
		const refreshToolProse = () => {
			const freshPieBasePrompt = getPieBaseSystemPrompt(ctx);
			if (currentPieBasePrompt === undefined || freshPieBasePrompt === undefined) {
				toolPromptRefreshFailed = true;
				return;
			}
			const rebased = rebasePieToolPrompt(modifiedSystemPrompt, currentPieBasePrompt, freshPieBasePrompt);
			if (rebased === undefined && currentPieBasePrompt !== freshPieBasePrompt) {
				toolPromptRefreshFailed = true;
				return;
			}
			modifiedSystemPrompt = rebased ?? modifiedSystemPrompt;
			currentPieBasePrompt = freshPieBasePrompt;
		};
		const setActiveTools = (names: string[]) => {
			const allowedChildTools = isChildSession ? getAllowedChildTools(sessionId) : undefined;
			const scopedNames = allowedChildTools
				? names.filter((name) => allowedChildTools.has(name))
				: names;
			toolSeams.setActiveTools(scopedNames);
			refreshToolProse();
		};
		const promptRefreshResult = () => modifiedSystemPrompt === event.systemPrompt
			? undefined
			: { systemPrompt: modifiedSystemPrompt };

		const autonomousMode = isAutonomousModeEnabled();
		if (autonomousMode) {
			const active = toolSeams.getActiveTools();
			if (active.includes(ASK_USER_TOOL_NAME)) {
				setActiveTools(active.filter((name) => name !== ASK_USER_TOOL_NAME));
			}
		}

		const reapplyChildSelection = () => {
			const hiddenNames = new Set(getHiddenSkills(sessionId).keys());
			if (hiddenNames.size === 0) return promptRefreshResult();
			const skills = (event.systemPromptOptions.skills ?? []) as Skill[];
			const match = modifiedSystemPrompt.match(SKILLS_BLOCK_RE);
			if (!match) return promptRefreshResult();
			const includedSkills = skills.filter((skill) => !hiddenNames.has(skill.name));
			modifiedSystemPrompt = modifiedSystemPrompt.replace(
				SKILLS_BLOCK_RE,
				buildReplacement(getFormatSkillsForPromptImpl()(includedSkills)),
			);
			return promptRefreshResult();
		};

		const queuedCount = queuedPrompts.get(event.prompt) ?? 0;
		if (queuedCount > 0) {
			if (queuedCount === 1) queuedPrompts.delete(event.prompt);
			else queuedPrompts.set(event.prompt, queuedCount - 1);
			return isChildSession && processedChildSessions.has(sessionId)
				? reapplyChildSelection()
				: promptRefreshResult();
		}
		if (isChildSession && processedChildSessions.has(sessionId)) {
			// Internal continuation/re-entry: the catalog and active-tool set from
			// the launch decision are still authoritative. Rebuild only the skills
			// block from that decision; never issue another prepass or reset recovery.
			return reapplyChildSelection();
		}

		const activeConfig = getConfig();
		if (isChildSession) processedChildSessions.add(sessionId);
		const skipInfo = shouldSkipPruning(event, activeConfig);
		const rootSessionFields = rootSessionAttribution(ctx, sessionId);
		// A new top-level pruning decision owns a fresh hidden-skill catalog.
		// Queued continuations returned above intentionally retain the current one.
		recordHiddenSkills(sessionId, []);
		const configuredTools = toolSeams.getAllTools();
		const blockedToolNames = new Set(autonomousMode ? [ASK_USER_TOOL_NAME] : []);
		const initialActiveToolNames = toolSeams.getActiveTools();
		if (isChildSession) recordAllowedChildTools(sessionId, initialActiveToolNames);
		const activeToolNames = initialActiveToolNames
			.filter((name) => !blockedToolNames.has(name));
		// An explicit empty selected-tools list is the backend's authoritative
		// signal that the user switched off the Tools system-prompt entry. Do not
		// let this extension's restoration/selection calls re-expose those schemas.
		const toolsManuallyDisabled = Array.isArray(event.systemPromptOptions.selectedTools)
			&& event.systemPromptOptions.selectedTools.length === 0;
		const previouslyPruned = getPrunedTools(sessionId);
		const childCanRecoverTools = !isChildSession || activeToolNames.includes(RECOVERY_TOOL_NAME);
		const consideredToolNames = toolsManuallyDisabled || !childCanRecoverTools
			? new Set<string>()
			: new Set([...activeToolNames, ...previouslyPruned].filter((name) => !blockedToolNames.has(name)));
		// Reconsider tools hidden by the preceding pruning decision, but never
		// pull in every configured tool: tools made inactive by the user or another
		// extension are outside skill-pruner's ownership.
		const availableTools = configuredTools.filter(
			(tool) => consideredToolNames.has(tool.name) && !blockedToolNames.has(tool.name),
		);
		const restorePrunerOwnedTools = () => {
			if (previouslyPruned.size === 0 || toolsManuallyDisabled) return;
			const restored = [...new Set([...activeToolNames, ...previouslyPruned])]
				.filter((name) => !blockedToolNames.has(name));
			setActiveTools(restored);
			recordPrunedTools(sessionId, []);
		};

		if (skipInfo.skip && (skipInfo.reason === "disabled-by-toggle" || skipInfo.reason === "subagent" || skipInfo.reason === "main-agent-disabled")) {
			// Subagent sessions own their scoped tool set, so never mutate it. When
			// the main-session extension/switch is disabled, restore only tools left
			// inactive by the pruner's prior auto-mode decision.
			if (skipInfo.reason === "disabled-by-toggle" || skipInfo.reason === "main-agent-disabled") {
				restorePrunerOwnedTools();
			}
			return promptRefreshResult();
		}

		const skills = event.systemPromptOptions.skills ?? [];
		const allSkillPaths = skills.map((s: Skill) => s.filePath);

		if (skipInfo.skip) {
			restorePrunerOwnedTools();
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			return promptRefreshResult();
		}

		// Shadow mode observes decisions but must undo any tool filtering left by
		// a preceding auto-mode turn.
		if (activeConfig.mode === "shadow") restorePrunerOwnedTools();

		const sessionPath = getSessionPath(ctx);
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
		let prepassInvocations: PrepassInvocation[] | undefined;
		let skillSafeguardReason: string | undefined;
		let toolSafeguardReason: string | undefined;
		let keptAllDueToParseFailure = false;
		let cacheHit = false;

		const hasToolsConfig = activeConfig.tools && availableTools.length > 0;

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
			const turnProtectedToolNames = event.prompt.startsWith(DEFERRED_TRIGGER_WAKE_PREFIX)
				? WAKE_TOOL_NAMES
				: [];
			const forcedToolNames = new Set<string>([
				...(activeConfig.tools?.alwaysKeep ?? []),
				RECOVERY_TOOL_NAME,
				...turnProtectedToolNames,
			]);

			const llmInput = {
				userPrompt: event.prompt,
				contextFile: contextFile?.path,
				skills: visibleSkills
					.filter((s) => !forcedSkillNames.has(s.name))
					.map((s) => ({ name: s.name, description: s.description })),
				tools: availableTools
					.filter((t) => !forcedToolNames.has(t.name))
					.map((t) => ({ name: t.name, description: t.description ?? "" })),
				config: activeConfig,
				recentConversation: getRecentConversation(ctx),
				...(isChildSession ? {
					agentContext: (subagentContext.getStore() as { agentContext?: string } | undefined)?.agentContext,
				} : {}),
			};

			let prunedSkills: string[] | null = null;
			let prunedTools: string[] | null = null;

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
				let prepassResult: PrepassRunResult;
				try {
					prepassResult = cached ?? await runPruningPrepass(ctx, llmInput, activeConfig, completeFn!);
				} catch (error) {
					// Unexpected scorer rejection is fenced too; otherwise preserve the
					// hook's existing error behavior for a still-live child owner.
					if (stopIfChildRuntimeDisposed()) return undefined;
					throw error;
				}
				// Check immediately after either successful or fail-open scorer results,
				// before caches, selectors, logger state, tool activation, or telemetry.
				if (!cached && stopIfChildRuntimeDisposed()) return undefined;
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
				prepassInvocations = prepassResult.prepassInvocations;
				keptAllDueToParseFailure = prepassResult.keptAllDueToParseFailure ?? false;
				cacheHit = prepassResult.cacheHit ?? false;
			}

			// Every failure is fail-open for tools, including auth/no-completion
			// failures that do not enter the normal selection/rendering path below.
			if (pruningError && activeConfig.mode === "auto") restorePrunerOwnedTools();

			if (!pruningError || pruningError.startsWith("Model") || pruningError.startsWith("LLM pruning failed")) {
				// Apply the tool decision first. Pi synchronously rebuilds its base prompt
				// in setActiveTools; the Pie-only context seam then lets us rebase the
				// chained prompt before filtering its skills block.
				const toolSelection = applyToolSelection(
					availableTools,
					prunedTools,
					activeConfig,
					turnProtectedToolNames,
				);
				toolSafeguardReason = toolSelection.safeguardReason ?? toolSafeguardReason;

				if (activeConfig.tools && availableTools.length > 0) {
					// Always apply the resolved auto-mode set, including keep-all and
					// fail-open outcomes, so tools pruned on a previous turn are restored.
					if (activeConfig.mode === "auto") {
						const hadPrunedTools = getPrunedTools(sessionId).size > 0;
						if (toolSelection.excludedToolNames.length > 0 || hadPrunedTools) {
							setActiveTools(toolSelection.includedToolNames);
						}
						recordPrunedTools(sessionId, toolSelection.excludedToolNames);
					}
					toolResult = {
						included: toolSelection.includedToolNames,
						excluded: toolSelection.excludedToolNames,
						tokensSaved: estimateToolTokens(availableTools, toolSelection.excludedToolNames),
					};
				}

				const toolsRemain = toolSelection.includedToolNames.length > 0;
				let skillSelection = applySkillSelection(visibleSkills, prunedSkills, effectivePinned, activeConfig, toolsRemain);
				const staleToolProseCannotBeRebased = toolPromptRefreshFailed
					&& /(?:^|\n)Available tools:\n/.test(event.systemPrompt);
				if (activeConfig.mode === "auto" && staleToolProseCannotBeRebased) {
					// Standalone Pi does not expose Pie's per-session accessor. Returning a
					// skill-edited copy of the pre-setActiveTools event would restore stale
					// tool prose, so fail open for skills instead.
					skillSelection = applySkillSelection(visibleSkills, null, effectivePinned, activeConfig, toolsRemain);
					skillSafeguardReason = "Pie fresh-base accessor unavailable; kept all skills to avoid restoring stale tool guidance";
				} else {
					skillSafeguardReason = skillSelection.safeguardReason ?? skillSafeguardReason;
				}

				// --- Skill pruning: rewrite the skills block in the fresh prompt ---
				const match = modifiedSystemPrompt.match(SKILLS_BLOCK_RE);
				let newSkillBlock = "";
				let originalSkillBlock = "";
				if (match) {
					const includedSkills = visibleSkills.filter((s) => skillSelection.includedSkillNames.includes(s.name));
					const excludedSkills = visibleSkills.filter((s) => skillSelection.excludedSkillNames.includes(s.name));
					const replacement = buildReplacement(getFormatSkillsForPromptImpl()(includedSkills));
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
					} else if (staleToolProseCannotBeRebased) {
						recordKnownSkills(sessionId, "auto", allSkillPaths, [], []);
						recordHiddenSkills(sessionId, []);
					} else {
						recordKnownSkills(sessionId, "auto", allSkillPaths, excludedSkillPaths, []);
						recordHiddenSkills(sessionId, excludedSkills);
						modifiedSystemPrompt = modifiedSystemPrompt.replace(SKILLS_BLOCK_RE, replacement);
						skillPruningRan = true;
					}
				} else if (skills.length > 0) {
					console.warn("[skill-pruner] skills block not found in system prompt; skipping skill pruning");
					recordSkillsBlockNotFound(sessionId, activeConfig.mode, rootSessionFields.rootSessionId);
					recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
				}

				// --- Audit decision: one row covering skills + tools so analytics sees both ---
				// (Previously only skill data was logged, so tool pruning was invisible to the
				// dashboard. Tool token estimates mirror the skill-block accounting.)
				const skillsBlockFound = !!match;
				const toolsConsidered = !!(activeConfig.tools && availableTools.length > 0);
				if (skillsBlockFound || toolsConsidered) {
					const decision = buildDecision({
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
						toolBlockTokens: toolsConsidered ? estimateToolTokens(availableTools, toolSelection.includedToolNames) : undefined,
						originalToolBlockTokens: toolsConsidered ? estimateToolTokens(availableTools, availableTools.map((t) => t.name)) : undefined,
						keptAllDueToParseFailure,
						cacheHit,
						prepassUsage,
						prepassSystemPrompt: rawSystemPrompt,
						prepassUserMessage: rawUserMessage,
						codeVersion: getCodeVersion(),
					});
					appendDecision({ ...decision, ...rootSessionFields });
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
			provider: activeConfig.provider,
			thinkingLevel: prepassThinkingLevel,
			response: rawResponse,
			thinking: rawThinking,
			systemPrompt: rawSystemPrompt,
			userMessage: rawUserMessage,
			latencyMs,
			usage: prepassUsage,
			prepassInvocations,
			cacheHit,
			error: pruningError,
			safeguardReason,
		});

		if (activeConfig.mode === "shadow") {
			if (toolPromptRefreshFailed && modifiedSystemPrompt === event.systemPrompt) {
				return feedbackMessage ? { message: feedbackMessage } : undefined;
			}
			return { systemPrompt: modifiedSystemPrompt, message: feedbackMessage ?? undefined };
		}
		if (skillPruningRan || modifiedSystemPrompt !== event.systemPrompt) {
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
				const sessionId = getSessionId(ctx);
				recordSkillRead(sessionId, readPath, rootSessionAttribution(ctx, sessionId).rootSessionId);
			}
		} catch (error) {
			console.warn(`[skill-pruner] failed to record skill read: ${toErrorMessage(error)}`);
		}
		return undefined;
	});
}
