import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { CompleteSimpleFn } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Shared mutable state for the skill-pruner extension.
 *
 * Uses a single exported object instead of individual `export let` bindings
 * so that esbuild's CJS compilation (used by test runner `require()`) passes
 * the object by reference rather than copying static values. All modules
 * read and write through the same `state` object.
 */
export const state = {
	/** Lazily-resolved reference to @earendil-works/pi-ai's completeSimple. */
	_piCompleteSimple: undefined as ((model: unknown, context: unknown, options: unknown) => Promise<unknown>) | null | undefined,

	/** Facade for pi API methods used for tool introspection. */
	piApi: null as {
		getAllTools: () => ToolInfo[];
		getActiveTools: () => string[];
		setActiveTools: (names: string[]) => void;
	} | null,

	configOverrideForTesting: null as PruningConfig | null,
	formatSkillsForPromptImpl: formatSkillsForPrompt as (skills: Skill[]) => string,

	/** Test seam: overrides getAllTools / getActiveTools / setActiveTools. */
	getAllToolsOverride: null as (() => ToolInfo[]) | null,
	getActiveToolsOverride: null as (() => string[]) | null,
	setActiveToolsOverride: null as ((names: string[]) => void) | null,

	/** Test seam: override the LLM completion function. Use `false` to simulate unavailable. */
	completeFnOverride: null as CompleteSimpleFn | null | false,

	/** Skills hidden by the latest auto-mode decision. Recovery reads only
	 * these trusted, already-discovered skill files; a new pruning decision
	 * replaces the catalog rather than accumulating session-long visibility. */
	hiddenSkills: new Map<string, Map<string, Skill>>(),

	/** Skills loaded through request_capability under the latest decision. */
	loadedSkills: new Map<string, Set<string>>(),

	/** Tools disabled by the latest auto-mode decision, tracked so neutral
	 * keep-all/off/shadow paths can restore only pruner-owned changes. */
	prunedTools: new Map<string, Set<string>>(),
};

/** Root of the pi-config repo, resolved from this extension's known position. */
export const CONFIG_ROOT = process.env.PI_CODING_AGENT_DIR
	? path.resolve(process.env.PI_CODING_AGENT_DIR)
	: path.resolve(import.meta.dirname, "..", "..", "..");

export const PROCESS_SESSION_ID = randomUUID();

/** Returns the pi API facade, falling back to no-ops when pi hasn't been initialized. */
export function getPiToolSeams(): {
	getAllTools: () => ToolInfo[];
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
} {
	return state.piApi ?? {
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
}

// Read-only accessors (use getter functions to work through esbuild CJS)
export function getConfigOverrideForTesting(): PruningConfig | null { return state.configOverrideForTesting; }
export function getFormatSkillsForPromptImpl(): (skills: Skill[]) => string { return state.formatSkillsForPromptImpl; }
export function getCompleteFnOverride(): CompleteSimpleFn | null | false { return state.completeFnOverride; }

// Setters for test seams
export function setConfigOverrideForTesting(value: PruningConfig | null): void { state.configOverrideForTesting = value; }
export function setFormatSkillsForPromptImpl(value: ((skills: Skill[]) => string) | null): void {
	state.formatSkillsForPromptImpl = value ?? formatSkillsForPrompt;
}
export function setAllToolsOverride(value: (() => ToolInfo[]) | null): void { state.getAllToolsOverride = value; }
export function setGetActiveToolsOverride(value: (() => string[]) | null): void { state.getActiveToolsOverride = value; }
export function setSetActiveToolsOverride(value: ((names: string[]) => void) | null): void { state.setActiveToolsOverride = value; }
export function setCompleteFnOverride(value: CompleteSimpleFn | null | false): void { state.completeFnOverride = value; }
export function setPiApi(value: typeof state.piApi): void { state.piApi = value; }
export function set_piCompleteSimple(value: typeof state._piCompleteSimple): void { state._piCompleteSimple = value; }

export function recordHiddenSkills(sessionId: string, skills: readonly Skill[]): void {
	if (skills.length === 0) state.hiddenSkills.delete(sessionId);
	else state.hiddenSkills.set(sessionId, new Map(skills.map((skill) => [skill.name, skill])));
	state.loadedSkills.delete(sessionId);
}

export function getHiddenSkills(sessionId: string): Map<string, Skill> {
	return state.hiddenSkills.get(sessionId) ?? new Map<string, Skill>();
}

export function recordLoadedSkill(sessionId: string, skillName: string): void {
	let loaded = state.loadedSkills.get(sessionId);
	if (!loaded) {
		loaded = new Set<string>();
		state.loadedSkills.set(sessionId, loaded);
	}
	loaded.add(skillName);
}

export function getLoadedSkills(sessionId: string): Set<string> {
	return state.loadedSkills.get(sessionId) ?? new Set<string>();
}

export function clearCapabilityStateForTesting(sessionId?: string): void {
	if (sessionId) {
		state.hiddenSkills.delete(sessionId);
		state.loadedSkills.delete(sessionId);
	} else {
		state.hiddenSkills.clear();
		state.loadedSkills.clear();
	}
}

export function getPrunedTools(sessionId: string): Set<string> {
	return state.prunedTools.get(sessionId) ?? new Set<string>();
}

export function recordPrunedTools(sessionId: string, names: readonly string[]): void {
	if (names.length === 0) state.prunedTools.delete(sessionId);
	else state.prunedTools.set(sessionId, new Set(names));
}

export function clearPrunedToolsForTesting(sessionId?: string): void {
	if (sessionId) state.prunedTools.delete(sessionId);
	else state.prunedTools.clear();
}