import { __setPromptTemplate as __setPruningPromptTemplate } from "../../harness/tool-and-skill-selection/prepass/llm-scorer.js";
import type { CompleteSimpleFn } from "../../harness/tool-and-skill-selection/prepass/llm-scorer.js";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	setConfigOverrideForTesting,
	setFormatSkillsForPromptImpl,
	setAllToolsOverride,
	setGetActiveToolsOverride,
	setSetActiveToolsOverride,
	setCompleteFnOverride,
	getHiddenSkills,
	recordHiddenSkills,
	recordPrunedTools,
	clearCapabilityStateForTesting,
	clearPrunedToolsForTesting,
} from "../../harness/tool-and-skill-selection/state/selector-state.js";
import register from "../../harness/tool-and-skill-selection/lifecycle/register.js";
import { clearPrepassCacheForTesting, setPrepassCacheNowForTesting } from "../../harness/tool-and-skill-selection/state/prepass-cache.js";
import { clonePruningConfig } from "../../harness/tool-and-skill-selection/lifecycle/pruning-lifecycle.js";
import { SKILLS_BLOCK_RE, MIN_PROMPT_LENGTH } from "../../harness/agent-instructions/skill-selection/skill-policy.js";
import { ensureCopilotHeaders, COPILOT_IDE_HEADERS } from "../../harness/model-providers/authentication/copilot-headers.js";

export default register;
export { SKILLS_BLOCK_RE, MIN_PROMPT_LENGTH };
export { getHiddenSkills, recordHiddenSkills, recordPrunedTools, clearCapabilityStateForTesting, clearPrepassCacheForTesting, setPrepassCacheNowForTesting };

// Test seams: setters exported from state module
export function setConfigForTesting(nextConfig: import("../../harness/tool-and-skill-selection/settings/config-types.js").PruningConfig | null): void {
	setConfigOverrideForTesting(nextConfig ? clonePruningConfig(nextConfig) : null);
}

export function resetForTesting(): void {
	setConfigOverrideForTesting(null);
	__setPruningPromptTemplate(null);
	setFormatSkillsForPromptImpl(null);
	setAllToolsOverride(null);
	setSetActiveToolsOverride(null);
	clearCapabilityStateForTesting();
	clearPrunedToolsForTesting();
	clearPrepassCacheForTesting();
	setPrepassCacheNowForTesting(null);
}

export function __setFormatter(fn: ((skills: Skill[]) => string) | null): void {
	setFormatSkillsForPromptImpl(fn);
}

export function __setCompleteFn(fn: CompleteSimpleFn | null): void {
	setCompleteFnOverride(fn === null ? false : fn);
}

export function __setToolSeams(opts: {
	getAllTools?: (() => ToolInfo[]) | null;
	getActiveTools?: (() => string[]) | null;
	setActiveTools?: ((names: string[]) => void) | null;
}): void {
	setAllToolsOverride(opts.getAllTools ?? null);
	setGetActiveToolsOverride(opts.getActiveTools ?? null);
	setSetActiveToolsOverride(opts.setActiveTools ?? null);
}

export function __ensureCopilotHeaders(model: Record<string, unknown>): Record<string, unknown> {
	return ensureCopilotHeaders(model);
}

export const __COPILOT_IDE_HEADERS = COPILOT_IDE_HEADERS;
