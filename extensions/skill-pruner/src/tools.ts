import { state, getPiToolSeams, recordRecoveredTool } from "./state.js";
import { getSessionId } from "./pruning.js";
import { recordToolRecovery } from "../logger.js";

export const requestToolDefinition = {
	name: "request_tool",
	label: "Request Tool",
	description: "List tools removed by the skill-pruner, or re-enable one for the rest of this session.",
	promptSnippet: "List or re-enable tools removed by the skill-pruner.",
	promptGuidelines: [
		"Use request_tool when a tool needed for the task is unavailable; omit toolName to list recoverable tools, then pass the exact name to enable one.",
	],
	parameters: {
		type: "object",
		properties: {
			toolName: {
				type: "string",
				description: "Exact name of the pruned tool to re-enable. Omit to list recoverable tools.",
			},
		},
	},
	async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: () => void, ctx: unknown) {
		const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const activeTools = state.getActiveToolsOverride
			? state.getActiveToolsOverride()
			: getPiToolSeams().getActiveTools();

		const knownNames = new Set(allTools.map((t) => t.name));
		if (!toolName) {
			const inactive = [...knownNames].filter((name) => !activeTools.includes(name)).sort();
			const text = inactive.length > 0
				? `Recoverable tools: ${inactive.join(", ")}`
				: "No tools are currently pruned.";
			return { content: [{ type: "text" as const, text }] };
		}
		if (!knownNames.has(toolName)) {
			return { content: [{ type: "text" as const, text: `Unknown tool '${toolName}'. Available tools: ${[...knownNames].sort().join(", ")}` }], isError: true };
		}
		if (activeTools.includes(toolName)) {
			return { content: [{ type: "text" as const, text: `Tool '${toolName}' is already active.` }] };
		}

		const newActiveTools = [...activeTools, toolName];
		if (state.setActiveToolsOverride) {
			state.setActiveToolsOverride(newActiveTools);
		} else {
			getPiToolSeams().setActiveTools(newActiveTools);
		}

		// Sticky recovery: record this tool so the next `before_agent_start`
		// protects it from re-pruning. `pi.setActiveTools()` only takes effect on
		// the NEXT turn (by SDK design), so without this the prepass would prune
		// the tool again next turn and the recovery would never take hold.
		const sessionId = getSessionId(ctx);
		try {
			recordRecoveredTool(sessionId, toolName);
		} catch {
			/* never let state tracking break recovery */
		}

		// Record that the agent had to recover a pruned tool — the key over-pruning
		// signal for analytics. Best-effort: never let logging break the recovery.
		try {
			recordToolRecovery(sessionId, toolName);
		} catch {
			/* ignore telemetry failures */
		}

		return { content: [{ type: "text" as const, text: `Enabled '${toolName}' for subsequent turns.` }] };
	},
};
