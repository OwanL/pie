import { readFileSync } from "node:fs";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	getHiddenSkills,
	getLoadedSkills,
	getPrunedTools,
	recordLoadedSkill,
} from "./state.js";
import { ASK_USER_TOOL_NAME, getConfig, getSessionId, isAutonomousModeEnabled } from "./pruning.js";
import { recordSkillRecovery, recordToolRecovery } from "../logger.js";

function stripFrontmatter(content: string): string {
	return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "").trim();
}

function formatSkill(skill: { name: string; filePath: string; baseDir: string }): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function commaList(names: readonly string[]): string {
	return names.length > 0 ? [...names].sort().join(", ") : "(none)";
}

export interface PiToolSeams {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

export function createRequestCapabilityDefinition(toolSeams: PiToolSeams) {
	return {
	name: "request_capability",
	label: "Request Capability",
	description: "List tools and skills hidden by the latest pruning decision, or activate/load one by exact type and name.",
	promptSnippet: "Poll for hidden tools or skills, then activate or load one by exact type and name.",
	promptGuidelines: [
		"Use request_capability only after checking the active tools and skills and finding no suitable capability. Never poll to verify, supplement, or replace a suitable active capability. Omit both arguments once to list hidden names, then pass the exact type and name; do not repeat a poll already in context.",
	],
	parameters: {
		type: "object",
		properties: {
			capabilityType: {
				type: "string",
				enum: ["tool", "skill"],
				description: "Type of hidden capability to select. Omit when listing.",
			},
			capabilityName: {
				type: "string",
				description: "Exact hidden capability name from a previous listing. Omit when listing.",
			},
		},
		additionalProperties: false,
	},
	async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: () => void, ctx: unknown) {
		const capabilityType = typeof params.capabilityType === "string" ? params.capabilityType.trim() : "";
		const capabilityName = typeof params.capabilityName === "string" ? params.capabilityName.trim() : "";
		const sessionId = getSessionId(ctx);
		const allTools = toolSeams.getAllTools();
		const activeTools = toolSeams.getActiveTools();
		const knownToolNames = new Set(allTools.map((tool) => tool.name));
		const autonomousMode = isAutonomousModeEnabled();
		const hiddenToolNames = [...getPrunedTools(sessionId)]
			.filter((name) => knownToolNames.has(name) && !activeTools.includes(name))
			.filter((name) => !autonomousMode || name !== ASK_USER_TOOL_NAME)
			.sort();
		const hiddenSkills = getHiddenSkills(sessionId);
		const loadedSkills = getLoadedSkills(sessionId);
		const hiddenSkillNames = [...hiddenSkills.keys()].filter((name) => !loadedSkills.has(name)).sort();

		if (!capabilityType && !capabilityName) {
			if (hiddenToolNames.length === 0 && hiddenSkillNames.length === 0) {
				return { content: [{ type: "text" as const, text: "No capabilities are hidden by the latest pruning decision." }] };
			}
			return { content: [{ type: "text" as const, text: `tools\t${commaList(hiddenToolNames)}\nskills\t${commaList(hiddenSkillNames)}` }] };
		}
		if (!capabilityType || !capabilityName) {
			return {
				content: [{ type: "text" as const, text: "Provide both capabilityType and capabilityName, or omit both to list hidden capabilities." }],
				isError: true,
			};
		}
		if (capabilityType !== "tool" && capabilityType !== "skill") {
			return { content: [{ type: "text" as const, text: "capabilityType must be 'tool' or 'skill'." }], isError: true };
		}
		if (autonomousMode && capabilityType === "tool" && capabilityName === ASK_USER_TOOL_NAME) {
			return { content: [{ type: "text" as const, text: "ask_user is unavailable while autonomous mode is active." }], isError: true };
		}

		if (capabilityType === "skill") {
			const skill = hiddenSkills.get(capabilityName);
			if (!skill || loadedSkills.has(capabilityName)) {
				if (hiddenToolNames.includes(capabilityName)) {
					return { content: [{ type: "text" as const, text: `'${capabilityName}' is a hidden tool, not a skill. Use capabilityType='tool'.` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: `No hidden skill named '${capabilityName}'. Poll without arguments for exact names.` }], isError: true };
			}
			try {
				const text = formatSkill(skill);
				recordLoadedSkill(sessionId, capabilityName);
				recordSkillRecovery(sessionId, capabilityName);
				return { content: [{ type: "text" as const, text }] };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Failed to load hidden skill '${capabilityName}': ${error instanceof Error ? error.message : String(error)}` }], isError: true };
			}
		}

		if (!hiddenToolNames.includes(capabilityName)) {
			if (hiddenSkillNames.includes(capabilityName)) {
				return { content: [{ type: "text" as const, text: `'${capabilityName}' is a hidden skill, not a tool. Use capabilityType='skill'.` }], isError: true };
			}
			return { content: [{ type: "text" as const, text: `No hidden tool named '${capabilityName}'. Poll without arguments for exact names.` }], isError: true };
		}

		const pruned = getPrunedTools(sessionId);
		const dependencies = getConfig().tools?.dependencies ?? {};
		const enabled = new Set(activeTools);
		const visited = new Set<string>();
		const visit = (name: string) => {
			if (visited.has(name) || !knownToolNames.has(name)) return;
			visited.add(name);
			if (name === capabilityName || pruned.has(name)) enabled.add(name);
			for (const dependency of dependencies[name] ?? []) visit(dependency);
		};
		visit(capabilityName);
		const newActiveTools = [...enabled];
		toolSeams.setActiveTools(newActiveTools);
		recordToolRecovery(sessionId, capabilityName);
		return { content: [{ type: "text" as const, text: `Enabled tool '${capabilityName}'; it is available on the next model step.` }] };
	},
	};
}
