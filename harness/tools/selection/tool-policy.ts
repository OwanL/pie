import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PruningConfig } from "../../tool-and-skill-selection/settings/config-types.js";

/** The pruner's own recovery tool. Hard-protected so hidden tools and skills
 * always retain one minimal, model-visible recovery path. */
export const RECOVERY_TOOL_NAME = "request_capability";

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
