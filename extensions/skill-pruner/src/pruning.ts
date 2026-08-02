import path from "node:path";
import type { Skill, ToolInfo, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { PruningConfig } from "../types.js";
import {
	getConfigOverrideForTesting,
	CONFIG_ROOT,
	PROCESS_SESSION_ID,
} from "./state.js";
import { parseJsonOrThrow } from "../../../shared/error-message.js";
import { isInSubagentContext } from "../../../shared/subagent-context.js";
import { ASK_USER_TOOL_NAME, isAutonomousModeEnabled } from "../../../shared/autonomous-mode.js";

export {
	buildPruningPayload,
	buildHint,
	buildReplacement,
	buildDecision,
	buildFeedbackMessage,
	estimateToolTokens,
	type PrepassDiagnostics,
} from "./message-builders.js";
export { COPILOT_IDE_HEADERS, ensureCopilotHeaders, withCopilotHeaders, withCopilotOptions } from "./copilot-headers.js";
export type { PrepassRunResult, PrepassUsage, SkillPruningResult, ToolPruningResult } from "./pruning-types.js";
export {
	getRecentConversation,
	getCompleteFn,
	completeOllamaNative,
	resolveModel,
	resolveAuth,
	prepassTimeoutMs,
	buildPrepassThinkingAttempts,
	hasUsablePrepassResponse,
	formatEmptyPrepassError,
	isTransportError,
	isTransportErrorMessage,
	PREPASS_MAX_TRANSPORT_RETRIES,
	resolvePrepassBudgets,
	runPruningPrepass,
	LLM_TIMEOUT_MS_BY_THINKING_LEVEL,
} from "./prepass.js";

/** Re-exported so tests can drive the shared AsyncLocalStorage signal that
 * `shouldSkipPruning` reads (same module instance the subagent runner sets). */
export { subagentContext } from "../../../shared/subagent-context.js";
export { ASK_USER_TOOL_NAME, isAutonomousModeEnabled };

/**
 * Locates the host-injected skills block in the system prompt so the pruner
 * can rewrite it. The leading `\n\s*` (rather than a brittle `\n\n`) tolerates
 * whitespace/newline-count variation in the host layout — if the block's exact
 * leading whitespace shifts slightly, matching still succeeds instead of
 * silently self-disabling skill pruning. The intro sentence and
 * `<available_skills>` tags remain the structural anchors, so behaviour is
 * unchanged when the block is present in the standard layout.
 */
export const SKILLS_BLOCK_RE = /\n\s*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
export const MIN_PROMPT_LENGTH = 8;

export function shouldSkipPruning(
	event: BeforeAgentStartEvent,
	activeConfig: PruningConfig,
): { skip: boolean; reason?: "disabled-by-toggle" | "off" | "too-short" | "subagent" } {
	if (isExtensionDisabledByToggle("skill-pruner")) {
		return { skip: true, reason: "disabled-by-toggle" };
	}
	// Subagent sessions are scoped, isolated tasks. The prepass is designed to
	// prune skills/tools for the main agent's broad context; running it inside
	// every subagent turn adds a 20–35s LLM call (plus a fail-open failure mode)
	// before the first streamed token, which makes subagents look hung. Skip it.
	if (isInSubagentContext()) {
		return { skip: true, reason: "subagent" };
	}
	if (activeConfig.mode === "off") {
		return { skip: true, reason: "off" };
	}
	if (event.prompt.trim().length < MIN_PROMPT_LENGTH) {
		return { skip: true, reason: "too-short" };
	}
	return { skip: false };
}

export function resolveVisibleSkills(skills: Skill[], activeConfig: PruningConfig) {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	const disabledNames = new Set(
		skills.filter((s) => s.disableModelInvocation).map((s) => s.name),
	);

	const visibleSkillNames = new Set(visibleSkills.map((s) => s.name));
	const effectivePinned = [...new Set([
		...(activeConfig.skills.pinned ?? []),
		...(activeConfig.skills.alwaysKeep ?? []),
	])].filter((name) => {
		if (disabledNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is disabled (disableModelInvocation); skipping`);
			return false;
		}
		if (!visibleSkillNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is not in the current session's visible skills; skipping`);
			return false;
		}
		return true;
	});

	return {
		visibleSkills,
		visibleSkillNames,
		effectivePinned,
	};
}

export function applySkillSelection(
	visibleSkills: Skill[],
	prunedSkills: string[] | null,
	effectivePinned: string[],
	_activeConfig: PruningConfig,
	// True when at least one tool survives tool-pruning. With tools available the
	// agent is still fully capable (zero skills leaves it functional, unlike zero
	// tools), so a legitimate full skill-prune is allowed through. Defaults to
	// false so callers that don't track tool state keep the historical
	// keep-all-on-full-prune behaviour.
	toolsRemain = false,
): { includedSkillNames: string[]; excludedSkillNames: string[]; safeguardReason?: string } {
	// No usable prepass signal → keep everything.
	if (prunedSkills === null) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
		};
	}

	const protectedNames = new Set(effectivePinned);
	const visibleNames = new Set(visibleSkills.map((s) => s.name));
	const pruneSet = new Set(
		prunedSkills.filter((name) => visibleNames.has(name) && !protectedNames.has(name)),
	);

	const excludedSkillNames = visibleSkills.filter((s) => pruneSet.has(s.name)).map((s) => s.name);
	const includedSkillNames = visibleSkills.filter((s) => !pruneSet.has(s.name)).map((s) => s.name);

	// Keep-all safeguard: when the prepass prunes every visible skill AND no tools
	// remain, we keep all skills rather than strip the lot. With tools still
	// available a full skill-prune is legitimate (none of the specialized skills
	// are relevant to the arc of work, e.g. a simple text edit), since zero skills
	// leaves the agent fully functional. Only when there are also no tools would
	// stripping every skill leave the agent with nothing. Pinned skills already
	// survive, so this only triggers when nothing at all would remain.
	if (includedSkillNames.length === 0 && visibleSkills.length > 0 && !toolsRemain) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
			safeguardReason: "LLM pruned every visible skill; keeping all as a safeguard",
		};
	}

	return { includedSkillNames, excludedSkillNames };
}

/** The pruner's own recovery tool. Hard-protected so hidden tools and skills
 * always retain one minimal, model-visible recovery path. */
export const RECOVERY_TOOL_NAME = "request_capability";

export function applyToolSelection(
	allTools: ToolInfo[],
	prunedTools: string[] | null,
	activeConfig: PruningConfig,
): { includedToolNames: string[]; excludedToolNames: string[]; safeguardReason?: string } {
	// No tools config (tool pruning disabled) or no tools present → keep everything.
	if (!activeConfig.tools || allTools.length === 0) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
		};
	}

	// No usable prepass signal → keep everything.
	if (prunedTools === null) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
		};
	}

	const alwaysKeepTools = activeConfig.tools.alwaysKeep ?? [];
	// Explicit always-keep tools and the recovery path itself are never pruned.
	// A tool recovered during the preceding request is deliberately reconsidered
	// by this new pruning decision rather than accumulating for the whole session.
	const protectedBase = new Set<string>([...alwaysKeepTools, RECOVERY_TOOL_NAME]);
	const allNames = new Set(allTools.map((t) => t.name));
	const pruneSet = new Set(
		prunedTools.filter((name) => allNames.has(name) && !protectedBase.has(name)),
	);

	// A tool that is a dependency (transitively) of a KEPT tool must not be pruned —
	// pruning it would strand the tool that needs it. Walk to a fixpoint.
	const dependencies = activeConfig.tools.dependencies;
	if (dependencies && pruneSet.size > 0) {
		let changed = true;
		while (changed) {
			changed = false;
			const kept = allTools.filter((t) => !pruneSet.has(t.name)).map((t) => t.name);
			for (const keptTool of kept) {
				for (const dep of dependencies[keptTool] ?? []) {
					if (pruneSet.has(dep)) {
						pruneSet.delete(dep);
						changed = true;
					}
				}
			}
		}
	}

	const excludedToolNames = allTools.filter((t) => pruneSet.has(t.name)).map((t) => t.name);
	const includedToolNames = allTools.filter((t) => !pruneSet.has(t.name)).map((t) => t.name);

	// Keep-all safeguard: a coding agent with zero tools is dead, so when the
	// prepass prunes every tool we keep all rather than strip the lot. alwaysKeep
	// already survives, so this only fires when nothing at all would remain.
	if (includedToolNames.length === 0 && allTools.length > 0) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
			safeguardReason: "LLM pruned every tool; keeping all as a safeguard",
		};
	}

	return { includedToolNames, excludedToolNames };
}

export function isExtensionDisabledByToggle(extensionId: string): boolean {
	const raw = process.env["PIE_EXTENSION_TOGGLES_JSON"];
	if (!raw) return false;
	try {
		const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, "extension toggles");
		if (!parsed || typeof parsed !== "object") return false;
		return parsed[extensionId] === false;
	} catch {
		return false;
	}
}

export function clonePruningConfig(input: PruningConfig): PruningConfig {
	return {
		mode: input.mode,
		model: input.model,
		provider: input.provider,
		thinkingLevel: input.thinkingLevel,
		skills: {
			strategy: input.skills.strategy,
			ceiling: input.skills.ceiling,
			pinned: [...(input.skills.pinned ?? [])],
			alwaysKeep: [...(input.skills.alwaysKeep ?? [])],
		},
		tools: input.tools ? {
			strategy: input.tools.strategy,
			ceiling: input.tools.ceiling,
			dependencies: Object.fromEntries(Object.entries(input.tools.dependencies).map(([k, v]) => [k, [...v]])),
			alwaysKeep: [...(input.tools.alwaysKeep ?? [])],
		} : undefined,
		prepass: input.prepass ? {
			...input.prepass,
			...(input.prepass.timeoutMs ? { timeoutMs: { ...input.prepass.timeoutMs } } : {}),
		} : undefined,
		autoSkipBelowTokens: input.autoSkipBelowTokens,
	};
}

export function getConfig(): PruningConfig {
	const override = getConfigOverrideForTesting();
	if (override) {
		return clonePruningConfig(override);
	}
	return loadConfig(path.join(CONFIG_ROOT, "settings.json"));
}

export function getSessionId(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionId?: () => string } | undefined;
	const sessionId = sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : PROCESS_SESSION_ID;
}

export function getSessionPath(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionFile?: () => string | undefined } | undefined;
	const sessionPath = sessionManager?.getSessionFile?.();
	return typeof sessionPath === "string" && sessionPath.length > 0 ? sessionPath : getSessionId(ctx);
}
