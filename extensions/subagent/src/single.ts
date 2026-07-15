import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agents.js";
import { getFinalOutput } from "../formatting.js";
import {
	runSingleAgent,
	subagentRuntime,
	consumeTreeSlot,
	type SubagentRuntimeContext,
} from "../runner.js";
import type { Static } from "@mariozechner/pi-ai";
import { SubagentParams } from "../schema.js";
import {
	MAX_MODEL_RETRIES,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "../types.js";
import {
	resolveModel,
	attachSelectionMetadata,
	isModelFailure,
	checkTrailLoop,
	type SelectionContext,
} from "./selection.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import type { ThinkingLevel } from "../bucket-selector.js";
import { compactSingleResult } from "./result-compaction.js";

export type SingleSubagentParams = Static<typeof SubagentParams>;
type MakeDetails = (results: SingleResult[]) => SubagentDetails;
type SingleResultEnvelope = AgentToolResult<SubagentDetails>;

function failureMessage(result: SingleResult): string {
	return result.errorMessage || result.stderr || result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}

function isResultError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

interface RunWithModelRetryArgs {
	agent: AgentConfig;
	excludeModels: Set<string>;
	bucket: string | undefined;
	thinkingLevel: string | undefined;
	activeModelId: string;
	selectionCtx: SelectionContext;
	childDepth: number;
	buildRuntime: () => SubagentRuntimeContext;
	signal: AbortSignal;
	runAttempt: (resolved: Awaited<ReturnType<typeof resolveModel>>) => Promise<SingleResult>;
}

async function runWithModelRetry(args: RunWithModelRetryArgs): Promise<SingleResult> {
	let result: SingleResult | undefined;
	let retryCount = 0;
	let lastFailedModel: string | undefined;

	for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
		const resolved = await resolveModel(
			args.agent,
			args.selectionCtx,
			args.activeModelId,
			args.bucket,
			args.thinkingLevel as ThinkingLevel | undefined,
			args.excludeModels,
			args.childDepth,
		);
		result = await subagentRuntime.run(args.buildRuntime(), () => args.runAttempt(resolved));
		attachSelectionMetadata(result, resolved);

		if (args.signal.aborted) break;
		const failure = args.selectionCtx.fallbackOnProviderFailure !== false
			&& resolved.selection?.fallback !== true
			&& isModelFailure(result, resolved.modelOverride, !!args.selectionCtx.bucketAssignments);
		if (!failure || attempt >= MAX_MODEL_RETRIES) break;

		args.excludeModels.add(resolved.modelOverride!);
		const next = await resolveModel(
			args.agent,
			args.selectionCtx,
			args.activeModelId,
			args.bucket,
			args.thinkingLevel as ThinkingLevel | undefined,
			args.excludeModels,
			args.childDepth,
		);
		// An exhausted bucket normally falls back to the parent's active model.
		// Provider failover is stricter: it may only dispatch another configured
		// model from this same bucket, never escape to an out-of-bucket parent.
		if (!next.modelOverride || next.selection?.fallback === true || args.excludeModels.has(next.modelOverride)) break;
		lastFailedModel = resolved.modelOverride;
		retryCount++;
	}

	if (!result) throw new Error("Subagent did not produce a result.");
	if (retryCount > 0) {
		result.failedModel = lastFailedModel;
		result.retryCount = retryCount;
	}
	return result;
}

/** Execute exactly one delegated task. Parallelism is provided exclusively by
 * pi's native sibling tool-call execution; dependent work uses later turns. */
export async function executeSingleTask(args: {
	params: SingleSubagentParams;
	ctx: ToolContext;
	agents: AgentConfig[];
	runtimeCtx: SubagentRuntimeContext;
	makeDetails: MakeDetails;
	onUpdate: OnUpdateCallback;
	signal: AbortSignal;
	selectionCtx: SelectionContext;
	toolCallId: string;
	parentUiBridge: ParentBridge | undefined;
	parentSessionId: string | undefined;
	allToolNames: string[] | undefined;
}): Promise<SingleResultEnvelope> {
	const { params, ctx, agents, runtimeCtx, makeDetails, onUpdate, signal, selectionCtx } = args;
	if (checkTrailLoop(params.agent, runtimeCtx.trail)) {
		throw new Error(`Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.`);
	}
	const treeLimitError = consumeTreeSlot(runtimeCtx.budget);
	if (treeLimitError) throw new Error(treeLimitError);

	const agent = agents.find((candidate) => candidate.name === params.agent);
	if (!agent) throw new Error(`Unknown subagent: ${params.agent}`);

	const result = await runWithModelRetry({
		agent,
		excludeModels: new Set<string>(),
		bucket: params.bucket,
		thinkingLevel: params.thinkingLevel,
		activeModelId: ctx.model?.id ?? "",
		selectionCtx,
		childDepth: runtimeCtx.depth + 1,
		signal,
		buildRuntime: () => ({
			depth: runtimeCtx.depth + 1,
			trail: [...runtimeCtx.trail, params.agent],
			canSpawn: agent.canSpawn,
			budget: runtimeCtx.budget,
			rootSessionPath: runtimeCtx.rootSessionPath ?? ctx.sessionManager?.getSessionFile?.() ?? undefined,
			keptSkills: runtimeCtx.keptSkills,
			processPermitScope: runtimeCtx.processPermitScope,
		}),
		runAttempt: (resolved) => {
			const selection = resolved.selection ?? {
				modelId: resolved.modelOverride ?? ctx.model?.id ?? "",
				thinkingLevel: resolved.thinkingLevel,
				bucket: resolved.bucket ?? "medium",
				pool: [],
				fallback: true,
			};
			return runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				params.task,
				params.cwd,
				undefined,
				signal,
				onUpdate,
				(results) => makeDetails(results),
				ctx.modelRegistry,
				ctx.model,
				selection,
				selectionCtx.disabledProviders,
				args.toolCallId,
				args.parentUiBridge,
				args.parentSessionId,
				args.allToolNames,
			);
		},
	});

	const compact = compactSingleResult(result);
	const details = makeDetails([compact]);
	if (isResultError(result)) {
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${failureMessage(compact)}` }],
			details,
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: compact.finalOutput || "(no output)" }],
		details,
	};
}
