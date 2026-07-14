/**
 * Helper utilities for the subagent extension.
 */

import type { AgentScope } from "../agents.js";
import type { SingleResult, SubagentDetails } from "../types.js";

/** Cap on sub-agent sessions spawned within a single subagent tool call (one reply). */
export const MAX_DEPTH = 3;

export function makeDetails(
	mode: "single" | "parallel" | "chain",
	results: SingleResult[],
	agentScope: AgentScope,
	projectAgentsDir: string | null,
): SubagentDetails {
	return {
		mode,
		agentScope,
		projectAgentsDir,
		results,
	};
}
