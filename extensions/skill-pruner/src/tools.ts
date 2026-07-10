import { state, getPiToolSeams, recordRecoveredTool } from "./state.js";
import { getSessionId } from "./pruning.js";
import { recordToolRecovery } from "../logger.js";

export const requestToolDefinition = {
	name: "request_tool",
	label: "Request Tool",
	description: "Request a tool that was pruned from the current session. Use when you need a tool that is not currently available. The tool will be enabled for the remainder of the session.",
	parameters: {
		type: "object",
		properties: {
			toolName: {
				type: "string",
				description: "The name of the tool to enable (e.g. 'web_search', 'fetch_content')",
			},
		},
		required: ["toolName"],
	},
	async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: () => void, ctx: unknown) {
		const toolName = params.toolName as string;
		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const activeTools = state.getActiveToolsOverride
			? state.getActiveToolsOverride()
			: getPiToolSeams().getActiveTools();

		const knownNames = new Set(allTools.map((t) => t.name));
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

		return { content: [{ type: "text" as const, text: `Tool '${toolName}' has been re-enabled and protected from re-pruning for this session. It becomes callable on the next turn (active-tool changes apply next turn); a same-turn call will still report not found.` }] };
	},
};
