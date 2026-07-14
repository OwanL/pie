/**
 * Compatibility wrapper for callers that imported the former single-mode
 * positional helper. Parallel and chain orchestration were intentionally
 * removed; use sibling subagent tool calls or later turns instead.
 */
import type { ToolContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agents.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "../types.js";
import type { SubagentRuntimeContext } from "../runner.js";
import type { SelectionContext } from "./selection.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import { executeSingleTask, type SingleSubagentParams } from "./single.js";

export type SubagentParams = SingleSubagentParams;

export function executeSingleMode(
	params: SingleSubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	_checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: (mode: "single", results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
	toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId?: string,
	allToolNames?: string[],
) {
	return executeSingleTask({
		params,
		ctx,
		agents,
		runtimeCtx,
		makeDetails: (results) => makeDetails("single", results),
		onUpdate,
		signal,
		selectionCtx,
		toolCallId,
		parentUiBridge,
		parentSessionId,
		allToolNames,
	});
}
