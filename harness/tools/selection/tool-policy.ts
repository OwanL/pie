import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PruningConfig } from "../../tool-and-skill-selection/settings/config-types.js";

/** The pruner's own recovery tool. Hard-protected so hidden tools and skills
 * always retain one minimal, model-visible recovery path. */
export const RECOVERY_TOOL_NAME = "request_capability";
export const SESSION_TASK_PROMPT_PREFIX = "[Pie session task:";
export const SESSION_CONTROL_TOOL_NAME = "session_control";
export const SESSION_ASSIGN_TOOL_NAME = "session_assign";
export const SESSION_FINISH_TOOL_NAME = "session_finish";
export const SESSION_WAIT_TOOL_NAME = "session_wait";

/** A coordinator-authenticated assignment prompt carries this display prefix.
 * It is a tool-visibility hint only; task ownership is enforced by the
 * coordinator, not inferred from model-visible prompt text. */
export function assignmentPromptProtectedTools(
	availableTools: readonly Pick<ToolInfo, "name">[],
	prompt: string,
): string[] {
	if (!prompt.startsWith(SESSION_TASK_PROMPT_PREFIX)) return [];
	return availableTools.some((tool) => tool.name === SESSION_FINISH_TOOL_NAME)
		? [SESSION_FINISH_TOOL_NAME]
		: [];
}

/** Retain a useful requester completion path when either lifecycle discovery
 * or assignment survives this selection. Names absent from the caller's
 * available set are never introduced, preserving user/child allowlists. */
export function sessionWorkflowProtectedTools(
	availableTools: readonly Pick<ToolInfo, "name">[],
	prunedTools: readonly string[] | null,
	prompt: string,
): string[] {
	const availableNames = new Set(availableTools.map((tool) => tool.name));
	const pruned = new Set(prunedTools ?? []);
	const protectedTools = assignmentPromptProtectedTools(availableTools, prompt);
	const controlSurvives = availableNames.has(SESSION_CONTROL_TOOL_NAME) && !pruned.has(SESSION_CONTROL_TOOL_NAME);
	const assignSurvives = availableNames.has(SESSION_ASSIGN_TOOL_NAME) && !pruned.has(SESSION_ASSIGN_TOOL_NAME);
	// A live lifecycle path must be able to start work on an already-created
	// cold peer. Keep assignment discoverable alongside lifecycle control, but
	// only when the caller's available catalog contains it (allowlists remain
	// authoritative).
	if (controlSurvives && availableNames.has(SESSION_ASSIGN_TOOL_NAME)) {
		protectedTools.push(SESSION_ASSIGN_TOOL_NAME);
	}
	const requesterPathSurvives = controlSurvives || assignSurvives;
	if (requesterPathSurvives && availableNames.has(SESSION_WAIT_TOOL_NAME)) {
		protectedTools.push(SESSION_WAIT_TOOL_NAME);
	}
	return protectedTools;
}

export function applyToolSelection(
	allTools: ToolInfo[],
	prunedTools: string[] | null,
	activeConfig: PruningConfig,
	additionalProtectedTools: Iterable<string> = [],
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
	const protectedBase = new Set<string>([
		...alwaysKeepTools,
		RECOVERY_TOOL_NAME,
		...additionalProtectedTools,
	]);
	const allNames = new Set(allTools.map((t) => t.name));
	const pruneSet = new Set(
		prunedTools.filter((name) => allNames.has(name) && !protectedBase.has(name)),
	);

	// A tool that is a dependency (transitively) of a KEPT tool must not be pruned —
	// pruning it would strand the tool that needs it. Walk to a fixpoint.
	const dependencies = activeConfig.tools.dependencies;
	if (pruneSet.size > 0) {
		let changed = true;
		while (changed) {
			changed = false;
			const kept = allTools.filter((t) => !pruneSet.has(t.name)).map((t) => t.name);
			for (const keptTool of kept) {
				const required = [
					...(dependencies?.[keptTool] ?? []),
					...(keptTool === SESSION_CONTROL_TOOL_NAME && allNames.has(SESSION_ASSIGN_TOOL_NAME)
						? [SESSION_ASSIGN_TOOL_NAME] : []),
					...((keptTool === SESSION_CONTROL_TOOL_NAME || keptTool === SESSION_ASSIGN_TOOL_NAME)
						&& allNames.has(SESSION_WAIT_TOOL_NAME) ? [SESSION_WAIT_TOOL_NAME] : []),
				];
				for (const dep of required) {
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
