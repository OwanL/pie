import { __setPromptTemplate as __setPruningPromptTemplate } from "./llm-scorer.js";
import type { CompleteSimpleFn } from "./llm-scorer.js";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	setPiApi,
	setConfigOverrideForTesting,
	setFormatSkillsForPromptImpl,
	setAllToolsOverride,
	setGetActiveToolsOverride,
	setSetActiveToolsOverride,
	setCompleteFnOverride,
	getRecoveredTools,
	clearRecoveredToolsForTesting,
	clearPrunedToolsForTesting,
} from "./src/state.js";
import register from "./src/register.js";
import { clearPrepassCacheForTesting, setPrepassCacheNowForTesting } from "./src/prepass-cache.js";
import {
	clonePruningConfig,
	ensureCopilotHeaders,
	COPILOT_IDE_HEADERS,
	SKILLS_BLOCK_RE,
	MIN_PROMPT_LENGTH,
} from "./src/pruning.js";

export default register;
export { SKILLS_BLOCK_RE, MIN_PROMPT_LENGTH };
export { getRecoveredTools, clearRecoveredToolsForTesting, clearPrepassCacheForTesting, setPrepassCacheNowForTesting };

// Test seams: setters exported from state module
export function setConfigForTesting(nextConfig: import("./types.js").PruningConfig | null): void {
	setConfigOverrideForTesting(nextConfig ? clonePruningConfig(nextConfig) : null);
}

export function resetForTesting(): void {
	setConfigOverrideForTesting(null);
	__setPruningPromptTemplate(null);
	setFormatSkillsForPromptImpl(null);
	setAllToolsOverride(null);
	setSetActiveToolsOverride(null);
	setPiApi(null);
	clearRecoveredToolsForTesting();
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
