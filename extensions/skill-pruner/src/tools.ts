import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	getHiddenSkills,
	getLoadedSkills,
	getPrunedTools,
	recordLoadedSkill,
} from "./state.js";
import { ASK_USER_TOOL_NAME, getConfig, getSessionId, isAutonomousModeEnabled } from "./pruning.js";
import { recordSkillRecovery, recordToolRecovery } from "../logger.js";
import { createRequestCapabilityTool, type RequestCapabilityPorts } from "../../../tools/request-capability/index.js";

export interface PiToolSeams {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

/**
 * SDK registration adapter for the skill-pruner-owned `request_capability`
 * tool. The implementation lives in `tools/request-capability` and receives
 * its dependencies through ports; this constructor wires them so the
 * pruner's session state (state.ts), pruning policy (pruning.ts), and
 * recovery telemetry (../logger.js) remain the single lifecycle owner —
 * the extracted tool duplicates none of it.
 */
export function createRequestCapabilityDefinition(toolSeams: PiToolSeams) {
	const ports: RequestCapabilityPorts = {
		...toolSeams,
		getSessionId,
		getPrunedTools,
		getHiddenSkills,
		getLoadedSkills,
		recordLoadedSkill,
		isAutonomousModeEnabled,
		askUserToolName: ASK_USER_TOOL_NAME,
		getToolDependencies: () => getConfig().tools?.dependencies ?? {},
		recordSkillRecovery,
		recordToolRecovery,
	};
	return createRequestCapabilityTool(ports);
}
