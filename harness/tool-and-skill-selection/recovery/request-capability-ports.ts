import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	getHiddenSkills,
	getLoadedSkills,
	getPrunedTools,
	recordLoadedSkill,
} from "../state/selector-state.js";
import { getConfig, getSessionId } from "../lifecycle/pruning-lifecycle.js";
import { isAutonomousModeEnabled } from "../settings/autonomous-mode.js";
import { ASK_USER_TOOL_NAME } from "../../tools/catalog/tool-names.js";
import { recordSkillRecovery, recordToolRecovery } from "../lifecycle/logger.js";
import { createRequestCapabilityTool, type RequestCapabilityPorts } from "../../tools/request-capability/index.js";

export interface PiToolSeams {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

/**
 * SDK registration adapter for the skill-pruner-owned `request_capability`
 * tool. The implementation lives in `harness/tools/request-capability` and receives
 * its dependencies through ports; this constructor wires them so the
 * selector state (../state/selector-state.js), pruning policy exposed through
 * the canonical selector lifecycle modules, and recovery
 * telemetry (../lifecycle/logger.js) remain under one lifecycle owner —
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
