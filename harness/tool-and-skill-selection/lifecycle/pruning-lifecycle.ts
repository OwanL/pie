import path from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../settings/config.js";
import type { PruningConfig } from "../settings/config-types.js";
import {
	getConfigOverrideForTesting,
	CONFIG_ROOT,
	PROCESS_SESSION_ID,
} from "../state/selector-state.js";
import { parseJsonOrThrow } from "../../../lib/structured-logging/error-message.js";
import { isInSubagentContext } from "../../agent-processes/lib/process-lifecycle/subagent-context.js";
import { MIN_PROMPT_LENGTH } from "../../agent-instructions/skill-selection/skill-policy.js";

export function shouldSkipPruning(
	event: BeforeAgentStartEvent,
	activeConfig: PruningConfig,
): { skip: boolean; reason?: "disabled-by-toggle" | "off" | "too-short" | "subagent" | "main-agent-disabled" } {
	if (isExtensionDisabledByToggle("skill-pruner")) {
		return { skip: true, reason: "disabled-by-toggle" };
	}
	// `off` and the global extension toggle remain global; the two booleans only
	// opt the main agent and subagents in/out independently.
	if (activeConfig.mode === "off") {
		return { skip: true, reason: "off" };
	}
	if (isInSubagentContext() && activeConfig.subagentEnabled === false) {
		return { skip: true, reason: "subagent" };
	}
	if (!isInSubagentContext() && activeConfig.mainAgentEnabled === false) {
		return { skip: true, reason: "main-agent-disabled" };
	}
	if (event.prompt.trim().length < MIN_PROMPT_LENGTH) {
		return { skip: true, reason: "too-short" };
	}
	return { skip: false };
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
		mainAgentEnabled: input.mainAgentEnabled ?? true,
		subagentEnabled: input.subagentEnabled ?? true,
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
